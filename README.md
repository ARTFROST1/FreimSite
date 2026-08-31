<div align="center">

![FreimSite banner](assets/banner.png)

<!-- GitHub social preview image lives at assets/social-preview.jpg — set it under
     Settings → General → Social preview once the file exists. -->

<h3>The official site template for Freim Deploy.</h3>

<p><b>A repository becomes a live site on its own domain — then the client edits<br>
their own content by clicking on the page itself, no admin panel, no code.</b></p>

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge"></a>
  <img alt="Astro 7" src="https://img.shields.io/badge/Astro-7-0ea5e9?style=for-the-badge&logo=astro&logoColor=white">
  <img alt="0 KB JS by default" src="https://img.shields.io/badge/default_JS-0_KB-8b5cf6?style=for-the-badge">
  <a href="https://github.com/ARTFROST1/FreimSite/generate"><img alt="Use this template" src="https://img.shields.io/badge/GitHub-Use_this_template-334155?style=for-the-badge&logo=github&logoColor=white"></a>
</p>

<p>
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/English-0ea5e9?style=flat-square"></a>
  <a href="README.ru.md"><img alt="Русский" src="https://img.shields.io/badge/Русский-334155?style=flat-square"></a>
</p>

</div>

---

## 🧊 What this is

Freim Deploy is a self-hosted deploy platform — a "Vercel on your own VPS": Node 22,
SQLite, [Caddy](https://caddyserver.com) and systemd, no Docker. FreimSite is what you
point it at.

The chain that makes this template worth using:

1. **You take this repository** and turn it into a specific site — brand colors, content,
   pages — in an afternoon, not a rebuild from scratch.
2. **You connect it to Freim Deploy.** Push, and the panel builds it, issues HTTPS, and
   puts it live on your client's own domain.
3. **The client edits it themselves.** They open their own site through a CMS portal,
   click a heading or a price the same way they'd click it as a visitor, type the new
   text, press publish. The change is committed to Git and redeployed — no code editor,
   no admin backend to teach them.

That last step is the reason this template exists as more than "a nice Astro starter":
every editable block on the site is wired, at the markup level, to make step 3 possible.

<div align="center">

![A site built from FreimSite, sections assembled from content collections](assets/screens/01-home.jpg)

![A product catalog page, generated from the same content collections](assets/screens/02-catalog.jpg)

![The client CMS portal: click-to-edit directly on the live page](assets/screens/03-portal-edit.jpg)

</div>

*The demo content shown above ships in Russian — it's the first thing you'll replace with
your own; the code, the schemas, and this documentation stay language-neutral.*

> [!NOTE]
> **Why the deploy config is called `frostdeploy.json`.** It's not a leftover from a
> half-finished rename. Freim Deploy — the platform this template deploys to — used to be
> called FrostDeploy, and its config filename is one of the few things the rebrand
> deliberately did **not** touch: servers already running in the field read that exact
> filename to find and apply their own updates, and renaming it here would break that
> silently. `frostdeploy.json` keeps its name for that reason — see the
> [Deploy](docs/en/deploy.md) page below.

---

## 🚀 Quick start

```bash
git clone https://github.com/ARTFROST1/FreimSite.git my-site
cd my-site
npm install
npm run dev
```

`http://localhost:4321` now serves a full demo site — home page, About, Gallery,
Contacts, a paginated blog and a small product catalog — built entirely from placeholder
content, ready to be replaced with a real one.

Full walkthrough, requirements and the command reference: **[docs/en/quick-start.md](docs/en/quick-start.md)**.

---

## ✨ What you get

|  | Feature | What it means |
| :-: | --- | --- |
| 🔍 | **SEO done properly** | A central SEO map, canonical URLs, OG/Twitter cards, hreflang, geo tags, JSON-LD for Organization, WebSite, LocalBusiness, BreadcrumbList, FAQPage and BlogPosting, sitemap, RSS and IndexNow — wired in, not bolted on |
| 🧩 | **Twenty content collections, under Zod** | Every editable block — hero, features, reviews, pricing, the product catalog, the blog — is a schema first: a typo fails the build instead of shipping an empty field |
| 🏝 | **Islands, not an app** | Astro renders the page as HTML at build time; React mounts only where something is genuinely interactive (a validated form, a lightbox) |
| 📬 | **Lead capture that's actually hardened** | A two-step lead form, an exit-intent popup, a promo banner, and a server-side pipeline with bot notifications and honeypot protection |
| 🎛 | **Media & UI without the React tax** | Lightbox, carousel, tabs, modal, video embed, before/after, a map component and more — all vanilla JS, all safe across client-side navigation |
| 📈 | **Analytics with a goal registry** | Yandex Metrika wired in behind a single declarative `data-goal` attribute, not scattered tracking calls |
| 🧱 | **A living component showcase** | Every section and UI primitive rendered on one page at `/ui-kit/` (excluded from search) — the reference you copy from while building |

---

## 📝 CMS

The client never opens this repository. They open their site through the **Freim Deploy
CMS portal**, which reads a contract this template generates for it
(`content.schema.json`) and turns every element marked `data-cms` in the page into
something clickable: click it, a form field lights up, type, and the page updates live
in the same view. Publish commits the change back to Git.

Wiring a new block into that contract — schema, JSON, `data-cms` markup, the guard test
that catches it if a refactor breaks it — is documented in full:
**[docs/en/cms.md](docs/en/cms.md)**.

---

## ☁️ Deploy

This template is built to deploy to **Freim Deploy**
([github.com/ARTFROST1/FreimDeploy](https://github.com/ARTFROST1/FreimDeploy)) — install it
on your own VPS, connect this repository, press Deploy. Nothing about the template locks
you into it: anything that runs `npm run build` and serves a static folder (or keeps a
Node process running) works too. The one file written specifically for the platform is
`frostdeploy.json`, described above and in full in **[docs/en/deploy.md](docs/en/deploy.md)**.

---

## 📚 Documentation

Five pages get you from a fresh clone to a real, deployed site without reading a word of
Russian:

| Page | What's in it |
| --- | --- |
| [Quick start](docs/en/quick-start.md) | Install, run, the command reference, what the demo site ships with |
| [Structure](docs/en/structure.md) | The directory map, and why most of the site ships zero JavaScript |
| [Content](docs/en/content.md) | Content collections, the Zod schemas behind them, adding your own |
| [CMS](docs/en/cms.md) | The contract that lets a client edit content through the portal |
| [Deploy](docs/en/deploy.md) | `frostdeploy.json` field by field, and why its name never changes |

> [!NOTE]
> **The deep material is in Russian.** Ten longer documents under [`docs/`](docs/) —
> [architecture](docs/ARCHITECTURE.md), [content policy](docs/CONTENT.md),
> [the CMS build process](docs/CMS-BUILDING.md), [images](docs/IMAGES.md),
> [SEO](docs/SEO.md), [performance](docs/PERFORMANCE.md), [legal](docs/LEGAL.md),
> [the site-building guide](docs/GUIDE.md), [the agent playbook](docs/AGENT-PLAYBOOK.md)
> and [analytics pitfalls](docs/ANALYTICS-PITFALLS.md) — plus twenty-three field-tested
> **[recipes](docs/recipes/README.md)** for things like lead pipelines, product feeds and
> scroll-driven animation. They're written in Russian because they double as the
> maintainer's own working notes, not because the content doesn't apply to you — an AI
> coding agent reads them just as well as the five English pages above, and a browser
> translates them adequately for a human.

---

## 📄 License

[MIT](LICENSE) — use it, fork it, adapt it, ship it in client work, commercially or
otherwise. No attribution required, though a link back is always welcome.

<div align="center">
<br>

**[🚀 Quick start](docs/en/quick-start.md)** · [CMS](docs/en/cms.md) · [Deploy](docs/en/deploy.md) ·
[Freim Deploy](https://github.com/ARTFROST1/FreimDeploy) ·
[Ask a question](https://github.com/ARTFROST1/FreimSite/issues/new/choose)

[English](README.md) · [Русский](README.ru.md)

<sub><b>FreimSite</b> — the official site template for <b>Freim Deploy</b>, a self-hosted
deploy platform. Astro 7, zero JavaScript by default, twenty Zod-validated content
collections, and a click-to-edit CMS contract out of the box.</sub>

<sub>© 2026 ARTFROST1</sub>

</div>
