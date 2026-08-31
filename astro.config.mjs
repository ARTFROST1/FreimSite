import fs from 'node:fs';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import rehypeSanitize from 'rehype-sanitize';

/**
 * Dev-only: снимает годовой кэш с картинок `astro:assets`.
 *
 * В деве оптимизированная картинка живёт по адресу вида
 * `/_image/?href=…/photo.jpg&w=330&f=webp` — в нём НЕТ хеша содержимого
 * (в отличие от прод-сборки, где хеш зашит в имя файла), а отдаётся она с
 * `cache-control: public, max-age=31536000`. Итог: правишь файл в
 * `src/assets/`, адрес не меняется — и браузер год показывает старую версию,
 * даже не спрашивая сервер. Выглядит как «правка не применилась», хотя на
 * диске и в сборке всё верно; лечится только hard-reload'ом.
 *
 * Astro-middleware сюда не годится: `/_image` в деве обслуживает Vite ещё до
 * роутера Astro. Поэтому перехватываем на уровне dev-сервера Vite и
 * подменяем только этот заголовок и только для `/_image`. `apply: 'serve'`
 * гарантирует, что в прод-сборку плагин не попадает вовсе — immutable-кэш
 * хешированных ассетов остаётся как есть.
 *
 * Портировано с боевого проекта (astro.config.mjs) без изменений в механике.
 */
function devImageNoStore() {
  return {
    name: 'starter:dev-image-no-store',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/_image')) {
          const setHeader = res.setHeader.bind(res);
          res.setHeader = (name, value) =>
            String(name).toLowerCase() === 'cache-control'
              ? setHeader(name, 'no-store, must-revalidate')
              : setHeader(name, value);
        }
        next();
      });
    },
  };
}

// ── SSR upgrade (see docs/en/deploy.md) ──────────────────────────────
// Node-адаптер нужен и лид-пайплайну v2: его SSR-роуты
// (src/pages/api/lead/*.ts.example) активируются только в hybrid-режиме
// с раскомментированным адаптером — см. docs/recipes/lead-pipeline.md.
// import node from '@astrojs/node';

// The canonical production URL. Everything SEO-related (canonical links,
// sitemap, OG tags, JSON-LD) is derived from this single value.
// CHANGE THIS FIRST for every new project.
const SITE_URL = 'https://example.com';

// ── Пустые категории каталога ────────────────────────────────────────
// Скан фронтматтеров товаров (fs, а не astro:content — коллекции в конфиге
// ещё недоступны) считает опубликованные товары по категориям: пустые
// категории выпадают из sitemap, а их страницы рендерятся с noindex
// (см. katalog/[...slug].astro). Наполнение категории автоматически
// возвращает её в индекс при следующей сборке. Паттерн — с боевого проекта.
const PRODUCTS_DIR = new URL('./src/content/products/', import.meta.url);
const productCountByCategory = {};
for (const file of fs.readdirSync(PRODUCTS_DIR)) {
  if (!file.endsWith('.md')) continue;
  const source = fs.readFileSync(new URL(file, PRODUCTS_DIR), 'utf8');
  const category = source.match(/^category:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1];
  const draft = /^draft:\s*true/m.test(source);
  if (category && !draft) {
    productCountByCategory[category] = (productCountByCategory[category] ?? 0) + 1;
  }
}

const CATEGORIES = JSON.parse(
  fs.readFileSync(new URL('./src/content/catalog/categories.json', import.meta.url), 'utf8'),
);
// Категории с детьми — развилки (fork): товаров напрямую не имеют и пустыми
// не считаются. Пустая — это grid-категория без единого опубликованного
// товара.
const FORK_IDS = new Set(CATEGORIES.filter((c) => c.parent).map((c) => c.parent));
// URL категории в стартере вложенный (/katalog/<родитель>/<id>/), поэтому
// матчим по хвосту `/<id>/`, а не по плоскому `/katalog/<id>/` (так было
// на боевом проекте с плоским деревом).
const EMPTY_CATEGORY_PATHS = CATEGORIES.map((c) => c.id)
  .filter((id) => !FORK_IDS.has(id) && !(productCountByCategory[id] > 0))
  .map((id) => `/${id}/`);

export default defineConfig({
  site: SITE_URL,
  // Always end URLs with a trailing slash. Keep this consistent with every
  // internal link (href="/about/") so canonical URLs never differ from what
  // the crawler requests.
  trailingSlash: 'always',

  // ── Rendering mode ──────────────────────────────────────────────────
  // 'static'  → pre-render every page to HTML. Deploy anywhere (Netlify,
  //             GitHub Pages, S3, any static host). Forms post to an
  //             external endpoint (PUBLIC_CONTACT_ENDPOINT). DEFAULT.
  //
  // HYBRID (recommended for VDS with forms): keep output:'static' and just
  //             uncomment the node adapter — static pages stay static, while
  //             API routes with `export const prerender = false` (like the
  //             activated api/contact.ts) render on demand. Best of both.
  //
  // 'server'  → every page on-demand. Only needed for per-request pages
  //             (auth, personalization, admin panels).
  output: 'static',
  // adapter: node({ mode: 'standalone' }),
  // output: 'server',

  // Behind a reverse proxy (Caddy/nginx) Astro can't verify Origin against
  // the real host, which blocks form POSTs — disable the built-in check
  // (our API route does its own origin allowlist):
  // security: { checkOrigin: false },

  // Needed when the host must bind 0.0.0.0 (Render, Docker, some PaaS):
  // server: { host: true },

  // ── 301 redirects (site migrations) ─────────────────────────────────
  // When replacing an old site, map EVERY old URL that had traffic/links to
  // its closest new page — link equity and index entries survive the move.
  // ⚠️ With trailingSlash:'always' NEVER add '/x' → '/x/' rules: '/x' and
  // '/x/' are the SAME route (normalizes into a self-redirect loop). Only
  // add CROSS-page moves (old URL → different new URL):
  // redirects: {
  //   '/old-page.html': '/new-page/',
  //   '/shop/category/': '/catalog/',
  // },

  // ── Whitespace between inline elements ──────────────────────────────
  // Astro 7 defaults to compressHTML:'jsx' — whitespace BETWEEN elements is
  // dropped, so `<span>a</span>\n<span>b</span>` renders "ab", not "a b".
  // Every component here spaces its inline children with flex+gap (see
  // Breadcrumbs.astro, BlogLayout tags), so the default is safe and we keep
  // the smaller HTML. If you add markup that leans on source whitespace to
  // separate words, either add an explicit {' '} or set compressHTML:true
  // to restore the pre-v7 HTML-aware behaviour.

  // ── Prefetch ─────────────────────────────────────────────────────────
  // 'hover' loads a page the moment the user shows intent (tap-start on
  // touch). The 'viewport' strategy would fetch every link that scrolls
  // into view — on a footer with 20 links that's ~100 KB of HTML competing
  // with images for mobile bandwidth.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },

  // ── Markdown (.md content collections — catalog product bodies etc.) ──
  // Astro's markdown pipeline has no built-in sanitizer: raw HTML written in
  // a .md body (or committed straight into the repo, or — pending CMS
  // portal-side validation for entries bodies — pasted by a client) is
  // passed through untouched, so a `<script>` in a product description
  // renders executable in dist/. rehype-sanitize strips it at the sink,
  // after any other rehype transform (keep it LAST in the array): it removes
  // script/style/iframe, all `on*` event-handler attributes and
  // `javascript:`-scheme URLs, while keeping ordinary formatting (headings,
  // lists, links, emphasis, images, code, tables — see `defaultSchema` from
  // `hast-util-sanitize`, the same allowlist GitHub uses to clean Markdown).
  // No custom schema needed here: verified against a product body using
  // headings/bold/italic/lists/links (all render) plus a `<script>` and an
  // `onerror` `<img>` payload (both fully stripped) — `rehypeSanitize()`
  // with no argument already uses `defaultSchema`.
  // Scope: THIS applies to `.md` content collections (products) only. The
  // blog's `.mdx` pipeline is intentionally decoupled below
  // (`mdx({ extendMarkdownConfig: false })`) — MDX compiles to JSX and
  // sanitizing its HAST tree the same way risks stripping legitimate
  // MDX/JSX nodes; that pipeline's own hardening is a separate task.
  markdown: {
    rehypePlugins: [rehypeSanitize],
  },

  // ── Картинки ─────────────────────────────────────────────────────────
  // Файлы из src/assets/ проходят через astro:assets (sharp): ресайз,
  // webp, srcset, width/height. Глобальный `layout` НЕ включаем сознательно:
  // он инжектит инлайновые стили размеров, которые конфликтуют с
  // Tailwind-утилитами (`h-full w-full object-cover`) на всех фоновых
  // картинках стартера. Ширины задаёт <ContentImage> явными `widths`.
  image: {
    responsiveStyles: false,
    service: { entrypoint: 'astro/assets/services/sharp' },
  },

  integrations: [
    react(),
    sitemap({
      // Never index internal/machine routes, nor pages that render `noindex`
      // themselves — держать их вне карты сайта тоже правильно: иначе краулеру
      // уходит сигнал «индексируй» для URL, чей собственный <meta
      // name="robots"> говорит обратное.
      //
      // Правовые страницы (/privacy-policy/, /terms/) в списке НЕТ намеренно:
      // публикация политики в свободном доступе — прямое требование ч. 2
      // ст. 18.1 152-ФЗ, и прятать её от поиска нет ни правовых, ни
      // маркетинговых оснований. (Пока это заглушки, у них стоит собственный
      // noindex — уберите его вместе с заменой текстов на реальные.)
      filter: (page) =>
        !page.includes('/admin') &&
        !page.includes('/api/') &&
        // Внутренний инструмент разбора фотоархива (noindex у него тоже стоит).
        !page.includes('/sortirovka') &&
        // Служебная витрина компонентов (src/pages/ui-kit/) — noindex, для
        // выбора блоков при сборке сайта и ручной QA, не страница сайта.
        !page.includes('/ui-kit/') &&
        !page.includes('/404') &&
        // Конверсионная страница «спасибо» — рендерится с noindex.
        !page.includes('/thanks/') &&
        // Товарные фиды (src/pages/yml.xml.ts, google-merchant.xml.ts) — это
        // машинные файлы для рекламных кабинетов, а не страницы сайта. В карте
        // сайта им нечего делать: сниппет из них не строится (его даёт разметка
        // на странице), а Директу и Merchant Center URL фида задают руками в
        // кабинете. Ср. /rss.xml — тот, наоборот, канал для читателей.
        !page.includes('/yml.xml') &&
        !page.includes('/google-merchant.xml') &&
        // Пустые категории каталога рендерятся с noindex (см.
        // katalog/[...slug].astro) — в sitemap им нечего делать.
        !EMPTY_CATEGORY_PATHS.some((path) => page.endsWith(path)),
      serialize(item) {
        const url = item.url;
        item.lastmod = new Date().toISOString().split('T')[0];

        if (url === `${SITE_URL}/`) {
          item.priority = 1.0;
          item.changefreq = 'weekly';
        } else if (url.includes('/blog/') && url !== `${SITE_URL}/blog/`) {
          item.priority = 0.6;
          item.changefreq = 'monthly';
        } else if (url.includes('/blog')) {
          item.priority = 0.7;
          item.changefreq = 'weekly';
        } else if (
          url.includes('/privacy') ||
          url.includes('/terms') ||
          url.includes('/legal')
        ) {
          item.priority = 0.3;
          item.changefreq = 'yearly';
        } else {
          item.priority = 0.7;
          item.changefreq = 'monthly';
        }
        return item;
      },
    }),
    // extendMarkdownConfig: false — freezes the blog's .mdx pipeline against
    // the `markdown` config above (and any future change to it). Without
    // this, MDX inherits `markdown.rehypePlugins` by default and would pick
    // up rehypeSanitize too; that's out of scope here (see comment above the
    // `markdown` key) and belongs to whoever hardens the blog pipeline.
    mdx({ extendMarkdownConfig: false }),
  ],

  vite: {
    plugins: [tailwindcss(), devImageNoStore()],
    // ── Кэш Vite: у сборки свой, отдельно от dev-сервера ──────────────
    // По умолчанию `astro dev` и `astro build` делят node_modules/.vite/deps,
    // и сборка переписывает его под собой у живого dev-сервера: имена файлов
    // хэшированные, после сборки старых больше нет. Открытая вкладка дёргает
    // исчезнувший модуль (первой падает dev-панель — audit/xray/toolbar),
    // Vite отвечает полной перезагрузкой, та валится на `astro:server-app.js`
    // — и демон остаётся жив, но битый: 500 и NoManifestAvailableError на
    // каждый рендер, пока его не убьёшь руками.
    //
    // Особенно больно потому, что `npm test` начинается со сборки, а
    // `astro dev` живёт фоновым демоном сутками — связь между «прогнал тесты»
    // и «сайт лёг» неочевидна совершенно.
    //
    // Кэш оптимизатора зависимостей — чистая оптимизация скорости, на
    // результат сборки он не влияет, поэтому развести их безопасно.
    cacheDir: process.argv.includes('build') ? 'node_modules/.vite-build' : 'node_modules/.vite',
  },
});
