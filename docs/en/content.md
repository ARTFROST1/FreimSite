# Content

## The rule

No text that a client might want to change lives in `.astro`, `.ts`, or
`.tsx`. The reason is practical, not stylistic: nothing that edits content
through a form or a visual editor can write TypeScript. Content lives as
JSON (or Markdown for blog posts and products) under `src/content/`,
validated by a Zod schema. Code holds structure and logic; content holds
the words.

## Where content lives

| Path | What |
| --- | --- |
| `src/content/home/*.json` | Home page blocks: hero, features, intro, showcase, gallery, reviews, pricing, FAQ, rating, team, stats, partners, timeline |
| `src/content/nav/*.json` | Cross-page: menu and footer labels, displayed phone, one-line address |
| `src/content/pages/pages.json` | Text for the About / Contacts / Gallery pages |
| `src/content/catalog/categories.json` | Product category tree (max 2 levels deep) |
| `src/content/products/*.md` | One file per product — frontmatter plus an optional markdown body |
| `src/content/blog/*.{md,mdx}` | Blog posts — `.md` client-edited through the portal, `.mdx` developer-only |
| `src/config/schemas.ts` | Zod schemas — shape, types, and form labels for all of the above |

## Zod schemas are the single source of truth

`src/config/schemas.ts` defines every content shape once, and that one
definition feeds three things at once:

1. **Build-time validation.** A typo in a field fails the build instead of
   shipping as an empty string in production.
2. **TypeScript types**, via `z.infer<typeof someSchema>` — rename a field
   and every component that reads it now fails to type-check, instead of
   silently rendering nothing.
3. **Editing-tool form fields**, through each field's human-readable
   description.

`src/content.config.ts` then registers each JSON file as an Astro content
collection (`defineCollection` + a `file()` loader), pointing at one of
those schemas. The repository currently declares about twenty collections
this way (`src/content.config.ts` → `export const collections`).

## Two shapes, one exception

Most collections are one of:

- **An array** — a JSON list of objects, each with a stable `id` (list
  order in the file is the display order; there's no separate `order`
  field to keep in sync).
- **A singleton** — a JSON object with one fixed key (usually `"main"`),
  for a block that only ever has one instance (the hero, for example).

Products and blog posts are a third shape (`entries`): one file per record
(`src/content/products/<slug>.md`, `src/content/blog/<slug>.md`) instead of
one row in a shared JSON array, because each record needs its own page and
its own body text. Categories are not part of that third shape —
`src/content/catalog/categories.json` is an ordinary array collection, one
JSON file holding the whole category tree, exactly like `features` or
`reviews`. The full mechanics of `entries` — and of adding a collection at
all — are in [cms.md](cms.md); this page only tells you what exists and
where.

## Adding your own collection, in short

1. Add a schema to `src/config/schemas.ts` (every field gets a
   human-readable description — it becomes the editor's form label).
2. Add the JSON file under `src/content/` and register it in
   `src/content.config.ts`.
3. Run `npx astro sync` so `astro:content` picks up the new collection's
   types.
4. Read it in a component with `getCollection()` / `getEntry()`.

That's enough to use the collection inside the codebase. Making it editable
by a client through the portal — the contract file, the click-to-edit
markup, the guard test — is a further chain of steps documented in
[cms.md](cms.md); skip it and the collection works on the site but stays
invisible to the portal.

## The blog

Posts are an `entries` collection at `src/content/blog/`, loaded from both
`.md` and `.mdx` files, with frontmatter validated by `blogPostSchema` in
`src/config/schemas.ts`. The listing is paginated: `/blog/` is page one,
`/blog/page/2/` onward are the rest, sized by `BLOG_PAGE_SIZE` in
`src/config/site.ts`.

The file extension is who-edits-it: **`.md` posts are client-edited through
the CMS portal** (the same plain markdown textarea as products), **`.mdx`
posts are developer-only** and may use JSX components inline
(`<ComparisonTable rows={...} />`). That split isn't stylistic — MDX
executes its body as JS at build time, so an uncontrolled textarea writing
`.mdx` can break the build on stray `{`/`</` characters; `.md` only ever
runs through the markdown parser and a sanitizer. The generated contract
registers the blog `entries` with `ext: ".md"`, so the portal only ever
sees `.md` posts — `.mdx` files are invisible to it by design, not by
convention. A guard test rejects the same slug existing as both `foo.md`
and `foo.mdx`.

Deeper material, including the decision history, lives in Russian:
[docs/CONTENT.md](../CONTENT.md).
