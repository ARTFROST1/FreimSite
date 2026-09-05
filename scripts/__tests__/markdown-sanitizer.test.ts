import { describe, it, expect, beforeAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * ЗАМОК НА САНИТАЙЗЕР ТЕЛА ТОВАРА.
 *
 * `rehype-sanitize` в `astro.config.mjs` — единственное, что стоит между телом
 * `.md`-записи каталога (его правит КЛИЕНТ через простую textarea портала) и
 * исполняемым кодом в собранном `dist/`. Охота 2026-08-01 показала это на
 * живом билде: `<script>` и `<img onerror>` из тела товара доезжали до
 * страницы работающими.
 *
 * Опасность этой защиты в том, что она отваливается МОЛЧА. Astro 7 перевела
 * markdown на Sätteri, а remark/rehype-конвейер сделала опциональным
 * процессором; слой совместимости (`coerceLegacyMarkdownPlugins` в
 * `astro/dist/core/config/validate.js`) при чужом процессоре просто печатает
 * предупреждение и ВЫБРАСЫВАЕТ плагины, оставляя сборку зелёной. Апгрейд
 * Astro, смена процессора, «уберу устаревшее поле» — любой из этих шагов
 * снимает защиту, и ни один тест по разметке этого не увидит.
 *
 * Поэтому тест не проверяет форму конфига (она переживёт что угодно), а берёт
 * процессор ИЗ РЕАЛЬНОГО `astro.config.mjs` и прогоняет через него боевой
 * payload — ровно так же, как это делает сборка. Упадёт он ровно тогда, когда
 * защита перестанет работать.
 *
 * ГРАНИЦА: это про весь `.md` — каталог И блог (клиентские статьи через
 * портал тоже `.md`, идут этим же конвейером). Сюда НЕ входит только
 * разработчицкий `.mdx` блога (`mdx({ extendMarkdownConfig: false })`):
 * rehype ходит по HAST и MDX/JSX не нейтрализует — у той трубы своя защита
 * и своя задача.
 */

interface MarkdownRenderer {
  render(content: string): Promise<{ code: string }>;
}
interface MarkdownProcessor {
  name: string;
  createRenderer(shared: Record<string, unknown>): Promise<MarkdownRenderer>;
}

const CONFIG_URL = pathToFileURL(resolve(import.meta.dirname, '../../astro.config.mjs')).href;

/** То же тело, что в исходной охоте: четыре вектора + легитимная разметка,
 *  которая обязана выжить (иначе «защита», которая режет всё, — не защита, а
 *  сломанный каталог). */
const PAYLOAD = [
  'Обычный **текст**, [ссылка](https://example.com/) и список:',
  '',
  '- пункт один',
  '- пункт два',
  '',
  '## Заголовок',
  '',
  "<script>alert('FD-XSS-SCRIPT')</script>",
  '',
  '<img src="x" onerror="alert(\'FD-XSS-ONERROR\')">',
  '',
  '<a href="javascript:alert(\'FD-XSS-JS-URL\')">клик</a>',
  '',
  '<iframe src="https://evil.example/"></iframe>',
  '',
  '<div onclick="alert(\'FD-XSS-ONCLICK\')">блок</div>',
].join('\n');

describe('markdown-санитайзер тела товара (.md)', () => {
  let html = '';
  let processor: MarkdownProcessor;

  beforeAll(async () => {
    const config = (await import(CONFIG_URL)).default;
    processor = config.markdown?.processor as MarkdownProcessor;
    expect(
      processor,
      'markdown.processor отсутствует в astro.config.mjs — санитайзер не к чему прицепить',
    ).toBeTruthy();
    const renderer = await processor.createRenderer({});
    html = (await renderer.render(PAYLOAD)).code;
  });

  it('в теле не остаётся ни одного исполняемого маркера', () => {
    for (const marker of [
      'FD-XSS-SCRIPT',
      'FD-XSS-ONERROR',
      'FD-XSS-JS-URL',
      'FD-XSS-ONCLICK',
    ]) {
      expect(html, `payload-маркер ${marker} долетел до вывода`).not.toContain(marker);
    }
  });

  it('вырезаны <script>, <iframe>, on*-обработчики и javascript:-схема', () => {
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('<iframe');
    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('onclick');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('обычное форматирование не пострадало — иначе это не защита, а сломанный каталог', () => {
    expect(html).toContain('<strong>текст</strong>');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('<li>');
    expect(html).toMatch(/<h2[\s>]/);
  });

  it('конвейер — тот самый unified c rehype-плагинами, а не безмолвная подмена', () => {
    // Имя процессора — единственный публичный признак того, что плагины из
    // конфига вообще кто-то исполняет: у `satteri()` их некому применить, и
    // Astro в этом случае лишь печатает предупреждение (см. доккоммент выше).
    expect(processor.name).toBe('unified');
  });
});
