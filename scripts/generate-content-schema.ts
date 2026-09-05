import { z } from 'astro/zod';
import {
  addressSchema,
  blogPostSchema,
  categorySchema,
  faqItemSchema,
  featureSchema,
  footerSchema,
  heroSchema,
  legalSchema,
  navigationSchema,
  pagesSchema,
  pricingPlanSchema,
  productSchema,
  ratingSchema,
  reviewSchema,
  partnerSchema,
  sectionTextsSchema,
  showcaseSlideSchema,
  statSchema,
  teamMemberSchema,
  timelineItemSchema,
} from '../src/config/schemas';

interface CollectionConfig {
  name: string;
  /** Russian display name shown in the portal's collection list. */
  label: string;
  schema: z.ZodTypeAny;
  filePath: string;
  kind: 'array' | 'singleton';
  singletonKey?: string;
  /** `kind: 'array'` only — how many items the CMS may put in this
   *  collection. See MAX_ITEMS below. */
  maxItems?: number;
}

/**
 * Upper bound on the item count of each array collection — the collection-level
 * companion to the `maxLength` caps in `src/config/schemas.ts` (see the
 * "LENGTH CAPS" block there and audit finding H-4). Values are far above any
 * realistic page: they exist so a compromised or buggy CMS client cannot commit
 * a 100 000-item array that blows up the build, the JSON-LD payload and the
 * page weight at once.
 *
 * PORTAL COUPLING: the portal validates array collections item-by-item against
 * `itemSchema` (`client-portal/src/services/content-service.ts` →
 * `validateCollectionValue`), so `maxLength` inside `itemSchema` is enforced
 * today while this collection-level cap is contract-only until that function
 * also checks it. Per-item caps are the ones that bound injection payload size,
 * so the security-relevant half is live; this half is a build-health guard.
 */
const MAX_ITEMS: Record<string, number> = {
  features: 12,
  reviews: 50,
  pricing: 12,
  faq: 50,
  showcase: 24,
  team: 24,
  stats: 8,
  partners: 30,
  timeline: 20,
};

/**
 * Explicit allowlist of client-editable collections — mirrors
 * `src/content.config.ts`, but only the subset the CMS portal may write.
 * `blog` is a "многофайловая" entries-коллекция, not a single-file
 * collection — it's registered in `ENTRIES` below, not here.
 */
const COLLECTIONS: CollectionConfig[] = [
  {
    name: 'hero',
    label: 'Первый экран',
    schema: heroSchema,
    filePath: 'src/content/home/hero.json',
    kind: 'singleton',
    singletonKey: 'main',
  },
  {
    name: 'sections',
    label: 'Тексты разделов',
    schema: sectionTextsSchema,
    filePath: 'src/content/home/sections.json',
    kind: 'singleton',
    singletonKey: 'main',
  },
  {
    name: 'features',
    label: 'Преимущества',
    schema: featureSchema,
    filePath: 'src/content/home/features.json',
    kind: 'array',
  },
  {
    name: 'reviews',
    label: 'Отзывы',
    schema: reviewSchema,
    filePath: 'src/content/home/reviews.json',
    kind: 'array',
  },
  {
    name: 'pricing',
    label: 'Тарифы',
    schema: pricingPlanSchema,
    filePath: 'src/content/home/pricing.json',
    kind: 'array',
  },
  {
    name: 'faq',
    label: 'Вопросы и ответы',
    schema: faqItemSchema,
    filePath: 'src/content/home/faq.json',
    kind: 'array',
  },
  {
    name: 'rating',
    label: 'Рейтинг',
    schema: ratingSchema,
    filePath: 'src/content/home/rating.json',
    kind: 'singleton',
    singletonKey: 'aggregate',
  },
  {
    name: 'showcase',
    label: 'Витрина (блок на главной)',
    schema: showcaseSlideSchema,
    filePath: 'src/content/home/showcase.json',
    kind: 'array',
  },
  {
    name: 'team',
    label: 'Команда',
    schema: teamMemberSchema,
    filePath: 'src/content/home/team.json',
    kind: 'array',
  },
  {
    name: 'stats',
    label: 'Цифры (факты о компании)',
    schema: statSchema,
    filePath: 'src/content/home/stats.json',
    kind: 'array',
  },
  {
    name: 'partners',
    label: 'Партнёры («Нам доверяют»)',
    schema: partnerSchema,
    filePath: 'src/content/home/partners.json',
    kind: 'array',
  },
  {
    name: 'timeline',
    label: 'История компании (этапы)',
    schema: timelineItemSchema,
    filePath: 'src/content/home/timeline.json',
    kind: 'array',
  },
  {
    name: 'navigation',
    label: 'Навигация (шапка сайта)',
    schema: navigationSchema,
    filePath: 'src/content/nav/navigation.json',
    kind: 'singleton',
    singletonKey: 'main',
  },
  {
    name: 'footer',
    label: 'Подвал сайта (футер)',
    schema: footerSchema,
    filePath: 'src/content/nav/footer.json',
    kind: 'singleton',
    singletonKey: 'main',
  },
  {
    name: 'address',
    label: 'Адрес',
    schema: addressSchema,
    filePath: 'src/content/nav/address.json',
    kind: 'singleton',
    singletonKey: 'main',
  },
  {
    name: 'pages',
    label: 'Тексты страниц (о нас / контакты / галерея)',
    schema: pagesSchema,
    filePath: 'src/content/pages/pages.json',
    kind: 'singleton',
    singletonKey: 'main',
  },
  {
    name: 'legal',
    label: 'Реквизиты в правовых документах',
    schema: legalSchema,
    filePath: 'src/content/legal/legal.json',
    kind: 'singleton',
    singletonKey: 'main',
  },
  {
    name: 'categories',
    label: 'Категории каталога',
    schema: categorySchema,
    filePath: 'src/content/catalog/categories.json',
    kind: 'array',
    maxItems: 40,
  },
];

/**
 * Куда CMS-портал коммитит загруженные клиентом картинки и какой префикс
 * получает значение поля в JSON.
 *
 * `src/assets/cms` (а не `public/`) — чтобы загрузки клиента проходили через
 * astro:assets: телефонное фото на 5 МБ превращается в webp с srcset, а не
 * отдаётся как есть. Значение поля — ключ реестра (`cms/<uuid>.png`), его
 * резолвит `src/lib/images/resolve.ts`.
 *
 * КРОСС-РЕПОЗИТОРНАЯ СВЯЗЬ: портал читает это поле из content.schema.json и,
 * если его нет (сайт на старой версии стартера), падает на прежние
 * `public/images/cms` + `/images/cms/`. Поэтому порядок выпуска сайта и
 * портала не важен — но и молча менять значения тут нельзя: смена `dir`
 * без переноса уже закоммиченных файлов оставит старые картинки не в реестре
 * (резолвер отдаст их как публичный URL — рабочий, но неоптимизированный).
 */
// Корень `src/assets`, а не `src/assets/cms` (урок боевого проекта): пикер портала
// показывает содержимое ровно этой папки, и пока она была вложенной, фото
// товаров (`products/<cat>/<slug>/…`) в него не попадали — клиент не мог
// перенести кадр из слайдера в галерею. Уже загруженные файлы в
// `src/assets/cms/` продолжают резолвиться по прежним ключам `cms/…`.
// `valuePrefix` пуст: ключ реестра и так считается от `src/assets/`.
const UPLOADS = { dir: 'src/assets', valuePrefix: '' } as const;

export interface UploadsContract {
  dir: string;
  valuePrefix: string;
}

export interface CollectionContract {
  kind: 'array' | 'singleton';
  /** Russian display name for the portal UI. */
  label: string;
  filePath: string;
  singletonKey?: string;
  /** Present on `kind: 'array'` only — max number of items (see MAX_ITEMS). */
  maxItems?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  itemSchema: Record<string, any>;
}

/**
 * Contract for a "многофайловая" (one Markdown/MDX file per item) collection —
 * distinct from `CollectionContract`, which is a single JSON file holding an
 * array or a singleton object. Products live under `dir` as one `.mdx` per
 * item with frontmatter validated against `itemSchema`; `body` describes
 * whether/how the portal edits the Markdown body below the frontmatter.
 */
export interface EntriesContract {
  label: string;
  dir: string;
  ext: string;
  routeBase: string;
  body: { enabled: boolean; format: 'markdown'; label: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  itemSchema: Record<string, any>;
}

const ENTRIES = [
  {
    name: 'products',
    label: 'Каталог товаров',
    schema: productSchema,
    dir: 'src/content/products',
    ext: '.md',
    routeBase: '/katalog',
    body: { enabled: true, format: 'markdown' as const, label: 'Подробное описание (необязательно)' },
  },
  {
    name: 'blog',
    label: 'Блог',
    schema: blogPostSchema,
    dir: 'src/content/blog',
    ext: '.md',
    routeBase: '/blog',
    body: { enabled: true, format: 'markdown' as const, label: 'Текст статьи' },
  },
];

export interface ContentSchemaDocument {
  version: 1;
  uploads: UploadsContract;
  collections: Record<string, CollectionContract>;
  /**
   * Entries-коллекции (одна запись — один Markdown/MDX-файл), опционально.
   * Аддитивное поле: `version` остаётся 1, порталы на прежней версии контракта
   * просто игнорируют `entries`, продолжая работать с `collections`.
   */
  entries?: Record<string, EntriesContract>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonSchemaLike = Record<string, any>;

/**
 * `z.toJSONSchema()` puts a field in `required` whenever the Zod schema
 * doesn't accept `undefined` — but a field with `.default(...)` is exactly
 * the opposite of "the client must supply this": Zod substitutes the default
 * when it's absent, so JSON Schema marking it required is a false positive.
 * It bit real content: the demo products never set `gallery`/`brands`/
 * `isHit`/`isNew`/`priority`/`draft` explicitly (they rely on the schema
 * default), so ajv rejected every one of them as missing required fields.
 *
 * Strips every `required` entry whose own property schema carries a
 * `default` key — recursively, since a nested `object` sub-schema has its
 * own independent `required` array (e.g. a future `object`-typed field with
 * defaulted sub-fields). Mutates and returns `schema` in place; safe because
 * `z.toJSONSchema()` returns a fresh object per call, never a cached one.
 */
function stripDefaultedRequired(schema: JsonSchemaLike): JsonSchemaLike {
  if (!schema || typeof schema !== 'object') return schema;

  if (Array.isArray(schema.required) && schema.properties) {
    schema.required = schema.required.filter(
      (key: string) => schema.properties[key]?.default === undefined,
    );
    if (schema.required.length === 0) delete schema.required;
  }

  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      stripDefaultedRequired(schema.properties[key]);
    }
  }
  if (schema.items) stripDefaultedRequired(schema.items);

  return schema;
}

export function buildContentSchema(): ContentSchemaDocument {
  const collections: Record<string, CollectionContract> = {};

  for (const c of COLLECTIONS) {
    const maxItems = c.kind === 'array' ? (c.maxItems ?? MAX_ITEMS[c.name]) : undefined;
    collections[c.name] = {
      kind: c.kind,
      label: c.label,
      filePath: c.filePath,
      ...(c.singletonKey ? { singletonKey: c.singletonKey } : {}),
      ...(maxItems ? { maxItems } : {}),
      itemSchema: stripDefaultedRequired(z.toJSONSchema(c.schema)),
    };
  }

  const entries: Record<string, EntriesContract> = {};
  for (const e of ENTRIES) {
    entries[e.name] = {
      label: e.label,
      dir: e.dir,
      ext: e.ext,
      routeBase: e.routeBase,
      body: e.body,
      itemSchema: stripDefaultedRequired(z.toJSONSchema(e.schema)),
    };
  }

  return { version: 1, uploads: { ...UPLOADS }, collections, entries };
}

interface CategoryLike {
  id: string;
  name: string;
  parent?: string;
}

/**
 * Каталог допускает только двухуровневое дерево категорий (верхний уровень +
 * его прямые дети) — так гарантированно не образуется третий уровень, который
 * никакая point-of-use логика (роутинг `/katalog`, хлебные крошки, фильтры) не
 * рассчитана рендерить. Бросает, если у категории с `parent` сам родитель
 * тоже имеет `parent` (глубина > 2), или если `parent` ссылается на
 * несуществующий id.
 */
export function assertCategoryDepth(categories: CategoryLike[]): void {
  // Astro's `file()` loader keys categories by `id` and silently
  // WARN-then-overwrites a duplicate rather than failing the build (verified
  // empirically — same for a duplicate static path) — so two categories
  // committed with the same `id` would quietly merge into one on the live
  // site with no error anywhere. Since this function already walks every
  // category before the build, it's the natural hard-fail point: throw with
  // every duplicated id listed (not just the first) so a client fixing
  // categories.json sees the whole problem at once, not one id per re-run.
  const seen = new Map<string, number>();
  for (const c of categories) {
    seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length > 0) {
    throw new Error(
      `Дублирующиеся id категорий: ${duplicates.join(', ')} — id категории должен быть уникальным.`,
    );
  }

  const byId = new Map(categories.map((c) => [c.id, c]));

  for (const c of categories) {
    if (!c.parent) continue;

    // Отдельная проверка ДО поиска родителя и ДО проверки глубины: без неё
    // parent === id проходит поиск (категория находит сама себя в byId) и
    // падает в ветку "превышена глубина" — сбивающее с толку сообщение для
    // того, что на самом деле является самоссылкой, а не деревом из 3 уровней.
    if (c.parent === c.id) {
      throw new Error(`Категория "${c.id}": ссылается сама на себя как на parent.`);
    }

    const parent = byId.get(c.parent);
    if (!parent) {
      throw new Error(
        `Категория "${c.id}": parent "${c.parent}" не найден среди категорий каталога.`,
      );
    }

    if (parent.parent) {
      throw new Error(
        `Категория "${c.id}": превышена допустимая глубина дерева категорий (parent "${parent.id}" сам является дочерней категорией — допускается только 2 уровня).`,
      );
    }
  }
}

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function isRunDirectly(): boolean {
  const invoked = process.argv[1];
  return Boolean(invoked && resolve(invoked) === fileURLToPath(import.meta.url));
}

if (isRunDirectly()) {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const categoriesPath = resolve(rootDir, 'src/content/catalog/categories.json');
  const categories = JSON.parse(readFileSync(categoriesPath, 'utf-8')) as CategoryLike[];
  assertCategoryDepth(categories);

  const outPath = resolve(rootDir, 'content.schema.json');
  writeFileSync(outPath, JSON.stringify(buildContentSchema(), null, 2) + '\n');
  console.log(`Wrote ${outPath}`);
}
