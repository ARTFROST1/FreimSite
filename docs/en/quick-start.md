# Quick start

FreimSite is a production-grade static site starter built on Astro 7: SEO,
analytics, content collections, and a set of ready sections (hero, features,
pricing, reviews, FAQ, and more). You edit config and content, not markup, to
turn it into a specific site.

The rest of the documentation (ten top-level docs under `docs/`, plus a
larger recipe library under `docs/recipes/`) is written in Russian, because
it is also the maintainer's daily working notes. These five pages are the
English entrance hall — enough to run the site locally, understand where
things live, and ship it.

## Requirements

- Node 22 (see `.nvmrc`)
- npm (the project is built and tested with npm, not pnpm or yarn — see
  [deploy.md](deploy.md) for why that matters at deploy time)

## Install and run

```bash
npm install
cp .env.example .env      # fill in values later, empty is fine to start
npm run dev                # http://localhost:4321
```

`npm install` pulls dependencies. `.env` holds optional keys (analytics IDs,
form endpoints, bot tokens) — the dev server runs fine with an empty file;
nothing you need to see the first screen depends on it. `npm run dev` starts
Astro's dev server on port 4321.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | local dev server with hot reload |
| `npm run build` | production build into `dist/` (also runs a `prebuild` step that regenerates `content.schema.json`, and a `postbuild` step that pings IndexNow) |
| `npm run preview` | serve the built `dist/` locally, to check the real output |
| `npm run check` | type-check and Astro diagnostics (same as `lint`/`typecheck`) |
| `npm test` | full suite: build, `vitest run`, then a smoke test — takes several minutes |

Always build through `npm run build`, not a bare `astro build`. The `prebuild`
and `postbuild` hooks only fire on the npm script, and skipping them means a
stale `content.schema.json` or a build search engines never hear about.

## What you get on first run

`npm run dev` serves a demo site: a home page assembled from sections (hero,
features, an intro block, a showcase, a gallery, reviews, pricing, a map
placeholder, a final call-to-action, FAQ), an About page, a Gallery page, a
Contacts page, a paginated blog with two demo posts, and a small product
catalog (`/katalog`) with a couple of demo categories and products. All of
the text on it is placeholder copy — replacing it is the next step.

## Turning it into your site

To get from the demo content to a real first screen, the files you touch
most are:

| File | What it controls |
| --- | --- |
| `astro.config.mjs` → `SITE_URL` | your canonical domain |
| `src/config/site.ts` | business name, phone, email, address, socials |
| `src/styles/global.css` → `@theme` | brand colors, fonts, radii |
| `src/content/**/*.json` | the text a client edits later, see [content.md](content.md) |

Everything else — page structure, sections, SEO wiring — stays as it is
until you have a reason to change it.

## Where to go next

- **[structure.md](structure.md)** — what the directory tree looks like and
  why most of the site ships zero JavaScript.
- **[content.md](content.md)** — where the text and data you see on the
  demo site actually live, and how to add your own content type.
- **[cms.md](cms.md)** — how a non-technical client edits that same content
  through a web portal instead of a code editor.
- **[deploy.md](deploy.md)** — what `frostdeploy.json` is and how a build
  reaches a live server.

## Making a real site out of this

If you're working with an AI coding agent, the full build process — parsing
a design reference into components, wiring content to the CMS, a launch
checklist — lives in `docs/AGENT-PLAYBOOK.md` (Russian). It's written to be
handed to an agent directly, prototype attached.

Deeper material lives in Russian: [docs/GUIDE.md](../GUIDE.md).
