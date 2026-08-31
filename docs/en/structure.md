# Project structure

## Directory tree

```
freimsite/
├── astro.config.mjs      # SITE_URL, rendering mode, sitemap/mdx/tailwind setup
├── frostdeploy.json      # deploy contract read by the Freim Deploy panel — see deploy.md
├── content.schema.json   # generated contract read by the CMS portal — see cms.md
├── .env.example           # template for environment variables
├── .nvmrc                 # Node version (22)
│
├── public/                # served as-is, no build step touches these files
│   ├── robots.txt, site.webmanifest, favicon.svg
│   ├── fd-edit.js         # CMS overlay script — see cms.md
│   ├── fonts/, og/         # self-hosted fonts, 1200×630 social preview images
│   └── images/             # a placeholder graphic and legacy loose files
│   # `npm run build:icons` fills in favicon.ico/.png duplicates and icons/
│
├── scripts/                # build-time and maintenance scripts (+ their tests)
│   └── generate-content-schema.ts  # writes content.schema.json from Zod schemas
│
├── src/
│   ├── assets/             # ★ content images, optimized by Astro — see below
│   ├── config/              # ★ project settings a developer edits
│   │   ├── site.ts          #   business name, contacts, address, coordinates
│   │   ├── nav.ts            #   menu/footer structure (ids and hrefs only)
│   │   ├── seo.ts            #   per-route meta
│   │   └── schemas.ts        #   Zod schemas — source of truth for content
│   │
│   ├── lib/                  # framework-free logic: analytics, UTM tracking,
│   │                         #   lead form engine, JSON-LD builders, image registry
│   ├── layouts/               # BaseLayout (<head>, chrome), BlogLayout
│   ├── components/
│   │   ├── layout/            #   Header, Footer — 0 JS
│   │   ├── sections/          #   Hero, Features, Pricing, FAQ, etc. — 0 JS
│   │   └── ui/                 #   shared widgets; a couple are React islands
│   │
│   ├── content.config.ts     # ★ declares every content collection
│   ├── content/                # ★ CONTENT — what a client edits, see content.md
│   ├── pages/                  # file-based routing (index.astro → `/`, etc.)
│   └── styles/global.css       # design tokens (`@theme`) + base styles
│
└── docs/                       # this documentation
```

★ marks the files you touch most when turning the template into a real site.
This is a trimmed view — the full annotated tree is in
[ARCHITECTURE.md](../ARCHITECTURE.md).

## Islands: why the page ships 0 KB of JavaScript by default

Astro's model is "the page is HTML, not JavaScript." Every `.astro` file —
layouts, sections, the header and footer — renders to static HTML at build
time and ships no JavaScript at all, unless you explicitly opt a piece of it
into being interactive.

That opt-in unit is called an **island**. Most of the site (text, images,
sections, SEO markup, JSON-LD) is plain `.astro`, zero JS. A few pieces need
real interactivity — a contact form with client-side validation, an image
gallery with a lightbox — and those are written as React components (`.tsx`)
and mounted as islands with a hydration directive placed on the `.astro` side
that uses them:

| Directive | Hydrates |
| --- | --- |
| `client:load` | immediately (only for critical above-the-fold UI) |
| `client:visible` | when the element scrolls into view (default for forms/galleries) |
| `client:idle` | when the browser is otherwise idle |
| `client:media="(...)"` | when a media query matches |

A menu toggle or an FAQ accordion doesn't need a React island — those are
small inline `<script>` snippets inside the `.astro` file itself. Reach for a
React island only when the interaction genuinely needs component state.

## `src/assets/` vs `public/`

Both hold images, but they are not interchangeable:

- **`src/assets/`** is processed by `astro:assets` at build time: resize,
  WebP/AVIF conversion, `srcset`, a content hash in the filename, a
  far-future cache header that's actually safe because the URL changes when
  the file does. This is where content photography goes — organized by
  convention into subfolders like `hero/`, `gallery/`, `sections/`, `blog/`,
  and `cms/` (uploads made by a client through the portal — do not edit by
  hand). Access goes through `src/lib/images/` (`registry.ts` / `resolve.ts`),
  not a raw import.
- **`public/`** is served byte-for-byte, unprocessed. Use it only when
  something needs a stable, predictable URL: Open Graph images, `favicon.*`,
  `robots.txt`, self-hosted font files, `fd-edit.js`. If a file in `public/`
  changes, its URL doesn't — so caching it aggressively is the visitor's
  problem, not yours.

The rule of thumb: needs a fixed external URL → `public/`; otherwise →
`src/assets/`.

Deeper material lives in Russian: [docs/ARCHITECTURE.md](../ARCHITECTURE.md).
