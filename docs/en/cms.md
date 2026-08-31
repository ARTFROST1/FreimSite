# CMS: how a client edits the site

A client edits their site through a separate web application — the Freim
Deploy CMS portal — not through this repository or a code editor. The
template's job is to expose the right hooks so that portal can read, show,
and write content back. Two files carry the whole contract:
`content.schema.json` (what can be edited, and its shape) and
`public/fd-edit.js` (a small script that turns click-to-edit on inside the
live page).

## `content.schema.json` — the contract

Generated from the Zod schemas in `src/config/schemas.ts` by
`npm run generate:content-schema` (also run automatically before every
build, as a `prebuild` step) and **committed to the repository** — the
portal reads it straight from the repo on the current commit, not from the
built `dist/` output.

Shape, in short:

```jsonc
{
  "version": 1,
  "uploads": { "dir": "src/assets", "valuePrefix": "" },
  "collections": {
    "features": {
      "kind": "array",           // or "singleton"
      "label": "Преимущества",   // human label shown in the portal
      "filePath": "src/content/home/features.json",
      "itemSchema": { /* JSON Schema, generated from the Zod schema */ }
    }
  },
  "entries": {
    "products": {
      "label": "Каталог товаров",
      "dir": "src/content/products",
      "ext": ".md",
      "routeBase": "/katalog",
      "body": { "enabled": true, "format": "markdown" },
      "itemSchema": { /* … */ }
    }
  }
}
```

`collections` covers the array/singleton content described in
[content.md](content.md). `entries` is a second, additive block for
one-file-per-record content like products — it has no click-to-edit markup
and is edited on its own portal screen instead, not through the generic
form-per-collection editor.

A test (`scripts/__tests__/generate-content-schema.test.ts`) compares the
committed file against a fresh generation and fails the build if someone
edits `schemas.ts` and forgets to regenerate.

## `data-cms` — click-to-edit markup

Inside a component, an editable element carries an attribute of the form:

```
data-cms="<collection>:<itemId>:<field>"
```

`itemId` is empty for a singleton (`collection::field`, two colons in a
row). `field` can be a dot path for a nested object (`cta.label`). The rule
that keeps this safe: the attribute goes on the element whose entire text
content equals the field's value, exactly — nothing else inside it. Put it
on an element with a child SVG or a nested tag and the first edit will wipe
that markup out, because applying an edit just overwrites `textContent`.

## `public/fd-edit.js` — the overlay

This script only activates when the page is opened inside an iframe with a
`?fd_edit=1&fd_origin=<portal origin>` query, or a previously accepted
origin cached in `sessionStorage` from an earlier load in the same tab. It
listens for messages from the portal (`init` to seed all editable text,
`apply` to rewrite one field live, `focus` to scroll to and highlight an
element, `mode` to flip between an editing state and a plain preview where
clicks behave like a normal visitor's) and reports back clicks and
navigation. Messages are only accepted from the origin the page was handed,
and the portal only accepts messages from a site's own registered URL.

In edit mode, clicking a `[data-cms]` element selects the matching field in
the portal's form panel. In preview mode, the overlay removes its own
listeners entirely, so links, accordions, and page navigation behave
exactly as they do for a real visitor.

## How editing actually happens, end to end

A client sees two ways to change something, both writing the same JSON
files under `src/content/`:

1. **A form.** The portal reads `content.schema.json`, draws one form field
   per schema field (using each field's description as its label), and
   writes the edited value back to the right JSON file.
2. **Click-to-edit.** The portal opens the live site in an iframe. Clicking
   a highlighted element (one with `data-cms`) jumps the form to that exact
   field; editing the form field updates the text on the page instantly,
   with no reload.

Adding a new collection so it appears in the portal at all is a chain of
steps — schema, JSON, collection registration, `data-cms` markup, a guard
test that catches markup a later refactor accidentally deletes — spelled
out in full in the Russian source below. This page is the summary of what
exists; that page is the one to follow while actually wiring up a new
editable block.

Deeper material lives in Russian: [docs/CMS-BUILDING.md](../CMS-BUILDING.md).
