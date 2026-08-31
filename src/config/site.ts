/**
 * ============================================================================
 *  SITE CONFIG — single source of truth for the brand & business.
 * ----------------------------------------------------------------------------
 *  Editing this file rebrands the whole site: header, footer, meta tags,
 *  JSON-LD structured data, contact links. No component hard-codes business
 *  data — everything reads from here.
 *
 *  ⚠️  FIRST STEPS for a new project:
 *    1. Change `url` here AND `SITE_URL` in astro.config.mjs (must match).
 *    2. Fill in name / legalName / contact / social / geo.
 *    3. Update the accent color in src/styles/global.css (@theme).
 *    4. Replace SEO copy in src/config/seo.ts.
 * ============================================================================
 */

export const SITE = {
  /** Canonical production URL, no trailing slash. MUST match astro.config.mjs `site`. */
  url: 'https://example.com',

  /** Brand / display name. */
  name: 'Brand Name',
  /** Short brand name for tight spots (header logo, nav). */
  shortName: 'Brand',
  /** Legal entity name for structured data / footer. */
  legalName: 'Brand LLC',

  /** Default tagline used on the home page hero. */
  tagline: 'A short, benefit-driven sentence about what you offer.',
  /** One-paragraph description reused in meta + Organization schema. */
  description:
    'Describe the business in 140–160 characters. This is the fallback meta description and the Organization schema description.',

  /** ISO language of the content. Drives <html lang> and og:locale. */
  lang: 'ru',
  locale: 'ru_RU',

  /** schema.org type for the business. LodgingBusiness, Restaurant, Store,
   *  ProfessionalService, LocalBusiness, Organization … pick the closest. */
  schemaType: 'LocalBusiness',

  /** Price band for LocalBusiness schema (e.g. "$$", "1000–5000 ₽"). */
  priceRange: '$$',

  /** Типовой срок изготовления/поставки в днях — ВЕРХНЯЯ граница того, что
   *  обещано на карточках товара. Читают товарные фиды: у Google
   *  `availability: preorder` требует `availability_date`, и дата обязана быть
   *  реальной оценкой готовности, а не заглушкой (см. src/config/feeds.ts).
   *  Для магазина со склада поставьте `FEEDS.madeToOrder: false` — тогда это
   *  число не используется. */
  productionLeadDays: 30,

  contact: {
    phone: '+7 (900) 000-00-00',
    /** E.164 for tel:/wa.me links — digits only, leading +. */
    phoneRaw: '+79000000000',
    email: 'hello@example.com',
  },

  /** Working hours: `display` — human string for UI (header/footer/contacts);
   *  `schema` — schema.org format ("Mo-Fr 09:00-18:00, Sa 09:00-15:00") used
   *  by LocalBusiness openingHours. Both empty → hidden/omitted everywhere. */
  workingHours: {
    display: '',
    schema: '',
  },

  address: {
    country: 'RU',
    region: 'Region',
    locality: 'City',
    street: 'Street name, 1',
    postalCode: '000000',
    /** Full human-readable address for footer/contacts. */
    full: 'City, Street name, 1',
  },

  /** Geo coordinates for LocalBusiness + geo meta tags. */
  geo: {
    lat: 55.751244,
    lng: 37.618423,
  },

  /** Social & messenger links. Empty string = hidden everywhere.
   *  Полный набор поддерживаемых иконок — config/socialIcons.ts; сеть,
   *  которой в этом списке нет, туда добавляют вместе с новым ключом здесь. */
  social: {
    telegram: '',
    whatsapp: '',
    max: '',
    vk: '',
    instagram: '',
    youtube: '',
    rutube: '',
  },

  /** Default Open Graph image (absolute path under /public). 1200×630. */
  ogImage: '/og/og-default.jpg',
} as const;

/** Absolute URL helper — always trailing-slashed, single source for canonicals. */
export function absoluteUrl(path = '/'): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const withSlash = clean.endsWith('/') || clean.includes('.') ? clean : `${clean}/`;
  return `${SITE.url}${withSlash}`;
}

/** Non-empty social links as [key, url] pairs, ready to render. */
export function activeSocialLinks(): Array<[keyof typeof SITE.social, string]> {
  return Object.entries(SITE.social).filter(([, v]) => v) as Array<
    [keyof typeof SITE.social, string]
  >;
}

/**
 * Размер страницы списка блога. Первая страница — `/blog/` (URL не меняется),
 * дальше — `/blog/page/2/` … (`src/pages/blog/page/[page].astro`,
 * `/blog/page/1/` не генерируется, чтобы не дублировать корень). Сетка
 * блога — 3 колонки на десктопе, поэтому число кратно трём: последняя строка
 * страницы не остаётся полупустой.
 */
export const BLOG_PAGE_SIZE = 9;
