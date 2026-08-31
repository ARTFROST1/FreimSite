import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Which fields MUST be visually editable (annotated with data-cms) for every
 * item of each collection. Extend this map when annotating new sections —
 * it is the single place that defines the click-to-edit surface.
 */
const VISUAL_FIELDS: Record<string, string[]> = {
  features: ['title', 'description'],
  reviews: ['author', 'text'],
  pricing: ['name', 'price', 'cta.label'],
  faq: ['question', 'answer'],
  showcase: ['title', 'description'],
  team: ['name', 'role'],
  stats: ['value', 'label'],
  partners: ['name'],
  timeline: ['date', 'title', 'description'],
};

/**
 * Optional fields of array collections: the element only renders when the
 * field is filled (empty `bio` → no paragraph, empty `logo` → text plaque
 * instead of an image), so the guard checks each item conditionally — same
 * "check only what's actually filled" convention as the reviews source line
 * below. Image fields (`photo`, `logo`) are annotated on the `<img>` itself
 * (`data-cms` + `data-fd-attr="src"`, see StackedShowcase).
 */
const OPTIONAL_VISUAL_FIELDS: Record<string, string[]> = {
  team: ['bio', 'photo'],
  stats: ['suffix'],
  partners: ['logo'],
};

/**
 * Singleton collections rendered on EVERY page (home included) — Header and
 * Footer are global layout chrome, `hero`/`sections` are home-only but the
 * home page is the one we read here. Annotated as `collection::field`
 * (empty itemId). Same rot-guard as VISUAL_FIELDS, one attribute per field.
 */
const SINGLETON_FIELDS: Record<string, string[]> = {
  hero: ['badge', 'title', 'subtitle', 'ctaPrimary', 'ctaSecondary'],
  sections: [
    'features.eyebrow',
    'features.title',
    'features.subtitle',
    'intro.eyebrow',
    'intro.title',
    'intro.body',
    'gallery.eyebrow',
    'gallery.title',
    'reviews.eyebrow',
    'reviews.title',
    'pricing.eyebrow',
    'pricing.title',
    'pricing.subtitle',
    'lead.title',
    'lead.subtitle',
    'lead.note',
    'map.eyebrow',
    'map.title',
    'cta.title',
    'cta.subtitle',
    'faq.eyebrow',
    'faq.title',
    'team.eyebrow',
    'team.title',
    'team.subtitle',
    'stats.eyebrow',
    'stats.title',
    'partners.title',
    'timeline.eyebrow',
    'timeline.title',
  ],
  navigation: [
    'phone',
    'ctaLabel',
    'menu.about',
    'menu.services',
    'menu.gallery',
    'menu.catalog',
    'menu.blog',
    'menu.contacts',
  ],
  footer: [
    'columns.sections.title',
    'columns.sections.links.home',
    'columns.sections.links.about',
    'columns.sections.links.gallery',
    'columns.sections.links.blog',
    'columns.sections.links.contacts',
    'columns.legal.title',
    'columns.legal.links.privacy',
    'columns.legal.links.consent',
    'columns.legal.links.terms',
    'copyrightSuffix',
  ],
  address: ['full'],
};

/**
 * `pages` singleton fields are route-specific: each nested block only
 * renders on its own page, so (unlike SINGLETON_FIELDS above) the home page
 * doesn't cover them — every non-home page with its own copy must be built
 * and checked individually. Keys are dist paths relative to `dist/`.
 */
const ROUTE_SINGLETON_FIELDS: Record<string, Record<string, string[]>> = {
  'about/index.html': {
    pages: [
      'about.heading.title',
      'about.heading.subtitle',
      'about.intro.eyebrow',
      'about.intro.title',
      'about.intro.body',
      'about.values.eyebrow',
      'about.values.title',
      'about.values.subtitle',
    ],
  },
  'contacts/index.html': {
    pages: ['contacts.heading.title', 'contacts.heading.subtitle'],
  },
  'gallery/index.html': {
    pages: ['gallery.heading.title', 'gallery.heading.subtitle'],
  },
  // Правовые документы. В CMS вынесены ТОЛЬКО факты оператора (реквизиты,
  // ФИО, даты редакций) — проза остаётся в коде, см. доккоммент legalSchema.
  // `legal::rkn.*` здесь нет намеренно: строка про уведомление Роскомнадзора
  // рендерится, только когда клиент заполнил номер и дату, а пока они пусты —
  // её в разметке нет.
  'privacy-policy/index.html': {
    legal: [
      'operator.fullName',
      'operator.inn',
      'operator.ogrnip',
      'operator.registrationAddress',
      'responsible.fullName',
      'dates.privacy',
    ],
    address: ['full'],
  },
  'terms/index.html': {
    legal: [
      'operator.fullName',
      'operator.inn',
      'operator.ogrnip',
      'operator.registrationAddress',
      'dates.terms',
    ],
    address: ['full'],
  },
  'soglasie-na-obrabotku-dannykh/index.html': {
    legal: [
      'operator.fullName',
      'operator.inn',
      'operator.ogrnip',
      'operator.registrationAddress',
      'dates.consent',
    ],
    address: ['full'],
  },
};

const ROOT = resolve(import.meta.dirname, '../..');
const DIST_INDEX = resolve(ROOT, 'dist/index.html');

/** Raw items of a `src/content/home/*.json` collection, typed by the caller —
 *  used where a field beyond `id` is needed (e.g. the conditional reviews
 *  source-line check below). */
function itemsOf<T extends { id: string }>(collection: string): T[] {
  return JSON.parse(
    readFileSync(resolve(ROOT, `src/content/home/${collection}.json`), 'utf-8'),
  ) as T[];
}

function itemIds(collection: string): string[] {
  return itemsOf<{ id: string }>(collection).map((item) => item.id);
}

/**
 * `categories` — единственная размеченная array-коллекция вне
 * `src/content/home/` (живёт в src/content/catalog/, это данные каталога, а
 * не главной), поэтому у неё свой загрузчик вместо `itemsOf()`. `description`
 * — единственное опциональное текстовое поле в `categorySchema`
 * (src/config/schemas.ts); если схема получит ещё поля, которые рендерятся
 * на страницах каталога, их нужно добавить и сюда, и в проверки ниже.
 */
interface CategoryItem {
  id: string;
  name: string;
  description?: string;
  parent?: string;
}

function categoryItems(): CategoryItem[] {
  return JSON.parse(
    readFileSync(resolve(ROOT, 'src/content/catalog/categories.json'), 'utf-8'),
  ) as CategoryItem[];
}

/** Every data-cms value must be exactly `collection:itemId:field` — 2 colons,
 *  itemId empty for singletons. Guards against typos like a stray ':' inside
 *  a dot-path field name. */
function assertNoMalformed(html: string, label: string) {
  const all = html.match(/data-cms="[^"]*"/g) ?? [];
  for (const attr of all) {
    const value = attr.slice('data-cms="'.length, -1);
    expect(value.split(':').length, `malformed ${attr} in ${label}`).toBe(3);
  }
}

describe('data-cms annotations (run `npm run build` first — reads dist/*.html)', () => {
  let homeHtml = '';

  beforeAll(() => {
    expect(
      existsSync(DIST_INDEX),
      'dist/index.html not found — run `npm run build` before `npm test`',
    ).toBe(true);
    homeHtml = readFileSync(DIST_INDEX, 'utf-8');
  });

  for (const [collection, fields] of Object.entries(VISUAL_FIELDS)) {
    it(`${collection}: every item has every visual field annotated (home page)`, () => {
      for (const id of itemIds(collection)) {
        for (const field of fields) {
          const attr = `data-cms="${collection}:${id}:${field}"`;
          expect(homeHtml.includes(attr), `missing ${attr} in dist/index.html`).toBe(true);
        }
      }
    });
  }

  for (const [collection, fields] of Object.entries(OPTIONAL_VISUAL_FIELDS)) {
    it(`${collection}: optional fields annotated when filled (home page)`, () => {
      for (const item of itemsOf<{ id: string } & Record<string, unknown>>(collection)) {
        for (const field of fields) {
          if (!item[field]) continue;
          const attr = `data-cms="${collection}:${item.id}:${field}"`;
          expect(homeHtml.includes(attr), `missing ${attr} in dist/index.html`).toBe(true);
        }
      }
    });
  }

  for (const [collection, fields] of Object.entries(SINGLETON_FIELDS)) {
    it(`${collection}: every singleton field annotated (home page)`, () => {
      for (const field of fields) {
        const attr = `data-cms="${collection}::${field}"`;
        expect(homeHtml.includes(attr), `missing ${attr} in dist/index.html`).toBe(true);
      }
    });
  }

  it('no malformed data-cms attributes on the home page', () => {
    assertNoMalformed(homeHtml, 'dist/index.html');
  });

  // Ported from a client project's ReviewsSection.astro: an optional "source" line
  // (e.g. a link back to the original Yandex/Google review) renders only
  // when BOTH `source` and `sourceUrl` are filled — a review missing either
  // one must not fail this rot-guard. Currently a no-op for this starter:
  // `reviewSchema` (src/config/schemas.ts) has no `source`/`sourceUrl`
  // fields yet and ReviewsSection.astro doesn't render them, so no item ever
  // has both set and the loop body never runs. Kept here so the guard is
  // already in place the day that field pair gets added — see the
  // `itemField`/`homeItems` doc-comment above for the same "check only what's
  // actually filled" convention.
  it('reviews: source line annotated when source+sourceUrl are filled', () => {
    for (const r of itemsOf<{ id: string; source?: string; sourceUrl?: string }>('reviews')) {
      if (!r.source || !r.sourceUrl) continue;
      for (const field of ['source', 'sourceUrl'] as const) {
        const attr = `data-cms="reviews:${r.id}:${field}"`;
        expect(homeHtml.includes(attr), `missing ${attr} in dist/index.html`).toBe(true);
      }
    }
  });

  // ---- non-home pages: the `pages` singleton is route-specific -----------
  for (const [route, collections] of Object.entries(ROUTE_SINGLETON_FIELDS)) {
    const distPath = resolve(ROOT, 'dist', route);

    describe(`dist/${route}`, () => {
      let html = '';

      beforeAll(() => {
        expect(
          existsSync(distPath),
          `dist/${route} not found — run \`npm run build\` before \`npm test\``,
        ).toBe(true);
        html = readFileSync(distPath, 'utf-8');
      });

      for (const [collection, fields] of Object.entries(collections)) {
        it(`${collection}: every singleton field annotated`, () => {
          for (const field of fields) {
            const attr = `data-cms="${collection}::${field}"`;
            expect(html.includes(attr), `missing ${attr} in dist/${route}`).toBe(true);
          }
        });
      }

      it('no malformed data-cms attributes', () => {
        assertNoMalformed(html, `dist/${route}`);
      });
    });
  }

  // ---- categories: catalog pages ------------------------------------------
  //
  // Коллекция живёт в src/content/catalog/categories.json, а её поля видны
  // не на главной, а на страницах /katalog/**, поэтому у неё свой блок, а не
  // строка в VISUAL_FIELDS.
  //
  // Где что рендерится:
  //   • корень каталога (/katalog/) — плитка CategoryCard каждой корневой
  //     категории: name + description;
  //   • своя страница категории — h1 всегда показывает имя КОРНЯ ветки
  //     (`categories:<root>:name`, category в CatalogPageProps — всегда
  //     root, см. buildCatalogPaths в src/lib/catalog.ts), description —
  //     поле текущей (sub)категории;
  //   • подкатегория дополнительно — плитка CategoryFork на странице
  //     родителя: name + description.
  describe('categories: catalog pages', () => {
    const categories = categoryItems();
    const roots = categories.filter((c) => !c.parent);
    const children = categories.filter((c) => c.parent);

    function readDistPage(route: string): string {
      const distPath = resolve(ROOT, 'dist', route);
      expect(
        existsSync(distPath),
        `dist/${route} not found — run \`npm run build\` before \`npm test\``,
      ).toBe(true);
      return readFileSync(distPath, 'utf-8');
    }

    it('catalog root: every root category card annotated (name + description)', () => {
      const html = readDistPage('katalog/index.html');
      for (const c of roots) {
        const attrs = [`data-cms="categories:${c.id}:name"`];
        if (c.description) attrs.push(`data-cms="categories:${c.id}:description"`);
        for (const attr of attrs) {
          expect(html.includes(attr), `missing ${attr} in dist/katalog/index.html`).toBe(true);
        }
      }
      assertNoMalformed(html, 'dist/katalog/index.html');
    });

    for (const c of categories) {
      const route = c.parent
        ? `katalog/${c.parent}/${c.id}/index.html`
        : `katalog/${c.id}/index.html`;
      it(`categories:${c.id}: own page annotated (dist/${route})`, () => {
        const html = readDistPage(route);
        const rootId = c.parent ?? c.id;
        const attrs = [`data-cms="categories:${rootId}:name"`];
        if (c.description) attrs.push(`data-cms="categories:${c.id}:description"`);
        for (const attr of attrs) {
          expect(html.includes(attr), `missing ${attr} in dist/${route}`).toBe(true);
        }
        assertNoMalformed(html, `dist/${route}`);
      });
    }

    for (const c of children) {
      const route = `katalog/${c.parent}/index.html`;
      it(`categories:${c.id}: fork tile on parent page annotated (dist/${route})`, () => {
        const html = readDistPage(route);
        const attrs = [`data-cms="categories:${c.id}:name"`];
        if (c.description) attrs.push(`data-cms="categories:${c.id}:description"`);
        for (const attr of attrs) {
          expect(html.includes(attr), `missing ${attr} in dist/${route}`).toBe(true);
        }
      });
    }
  });
});
