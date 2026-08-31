/**
 * ============================================================================
 *  STRUCTURED DATA (schema.org / JSON-LD) builders.
 * ----------------------------------------------------------------------------
 *  Structured data is how search engines understand *what* a page is. It
 *  powers rich results (ratings, breadcrumbs, FAQ accordions, article cards).
 *  Emit these via <JsonLd /> (see components/seo/JsonLd.astro).
 *
 *  Validate output with: https://validator.schema.org and Google's Rich
 *  Results Test before shipping.
 * ============================================================================
 */
import { SITE, absoluteUrl, activeSocialLinks } from '../config/site';

type Json = Record<string, unknown>;

/**
 * Stable @id anchors — schemas reference each other through these instead of
 * duplicating data (the catalogue-reference pattern): Organization owns
 * `#organization`, WebSite owns `#website`; Service/Article/Product point back
 * via `@id`.
 */
export const ORG_ID = `${SITE.url}/#organization`;
export const WEBSITE_ID = `${SITE.url}/#website`;

/** Organization — put on every page (usually in BaseLayout). */
export function organizationSchema(): Json {
  const sameAs = activeSocialLinks().map(([, url]) => url);
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': ORG_ID,
    name: SITE.name,
    legalName: SITE.legalName,
    url: SITE.url,
    // Растровый логотип ≥112×112 (требование логотипа в выдаче Google) и
    // обязательно с фоном: под альфу парсеры подкладывают что угодно.
    // Генерация из мастер-SVG: npm run build:icons.
    logo: absoluteUrl('/logo.png'),
    description: SITE.description,
    ...(sameAs.length ? { sameAs } : {}),
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: SITE.contact.phoneRaw,
      email: SITE.contact.email,
      contactType: 'customer service',
      areaServed: SITE.address.country,
    },
  };
}

/** WebSite — enables the sitelinks search box; put on the home page. */
export function webSiteSchema(): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    name: SITE.name,
    url: SITE.url,
    description: SITE.description,
    inLanguage: SITE.lang,
    publisher: { '@id': ORG_ID },
  };
}

/**
 * LocalBusiness — for businesses with a physical address / service area.
 *
 * ⚠️ БЕЗ `aggregateRating` — СОЗНАТЕЛЬНО. Google прямо запрещает звёзды на
 * `Organization` и её подтипах, когда оценивают сами себя («If the entity
 * that's being reviewed controls the reviews about itself … ineligible for
 * star review feature»), и отдельно запрещает переносить рейтинг с чужих
 * площадок (агрегаторов отзывов, карт и т.п.) — нарушение сразу по двум
 * пунктам грозит ручными санкциями.
 *
 * На странице рейтинг может оставаться (он правдив и работает на конверсию) —
 * из разметки он просто убран. Если понадобятся звёзды в выдаче,
 * `aggregateRating` размечается ТОЛЬКО на `Product` и только по настоящим
 * отзывам клиентов, видимым на той же странице.
 */
export function localBusinessSchema(opts?: { images?: string[] }): Json {
  return {
    '@context': 'https://schema.org',
    '@type': SITE.schemaType,
    name: SITE.name,
    url: SITE.url,
    description: SITE.description,
    telephone: SITE.contact.phoneRaw,
    email: SITE.contact.email,
    priceRange: SITE.priceRange,
    image: opts?.images?.map((i) => absoluteUrl(i)) ?? [absoluteUrl(SITE.ogImage)],
    address: {
      '@type': 'PostalAddress',
      addressCountry: SITE.address.country,
      addressRegion: SITE.address.region,
      addressLocality: SITE.address.locality,
      streetAddress: SITE.address.street,
      // Пустая строка в postalCode — мусор для валидатора; поле включается,
      // только когда индекс реально известен и заполнен в site.ts.
      ...(SITE.address.postalCode ? { postalCode: SITE.address.postalCode } : {}),
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: SITE.geo.lat,
      longitude: SITE.geo.lng,
    },
    ...(SITE.workingHours.schema
      ? { openingHours: SITE.workingHours.schema }
      : {}),
  };
}

/** BreadcrumbList — pass ordered [{ name, url? }] (last item usually no url). */
export function breadcrumbSchema(items: { name: string; url?: string }[]): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      ...(item.url ? { item: absoluteUrl(item.url) } : {}),
    })),
  };
}

/** FAQPage — only when the Q&A is visibly on the page. */
export function faqSchema(items: { question: string; answer: string }[]): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
}

/**
 * Product — for catalog / product pages (Google Merchant-ready).
 * With both prices → AggregateOffer (price range); one price → Offer.
 * ⚠️ No aggregateRating/review here BY DEFAULT — this function just doesn't
 * wire them up yet. Unlike LocalBusiness (see localBusinessSchema() above,
 * deliberately WITHOUT aggregateRating — Google disallows a business rating
 * itself), Product IS the correct place for star ratings: add
 * aggregateRating/review here if the project has REAL per-product reviews
 * visible on that same page — fake ones are a Google manual-action risk
 * regardless of which type carries them.
 */
export function productSchema(opts: {
  name: string;
  description: string;
  url: string;
  image: string;
  category?: string;
  brand?: string;
  features?: { name: string; value: string }[];
  lowPrice?: number;
  highPrice?: number;
  currency?: string;
  /** Полный schema.org-URL наличия. По умолчанию PreOrder — товар делается
   *  под заказ, а не берётся с полки; переопредели, если у проекта склад
   *  готовых позиций. */
  availability?: string;
}): Json {
  const currency = opts.currency ?? 'RUB';
  const offerBase = {
    priceCurrency: currency,
    availability: opts.availability ?? 'https://schema.org/PreOrder',
    seller: { '@id': ORG_ID },
  };
  // Одна цена → тоже AggregateOffer с lowPrice (а не одиночный Offer): так
  // оба поисковика рисуют «от N ₽» и для товара без верхней границы цены.
  const offers = opts.lowPrice
    ? {
        '@type': 'AggregateOffer',
        lowPrice: opts.lowPrice,
        ...(opts.highPrice ? { highPrice: opts.highPrice } : {}),
        ...offerBase,
      }
    : undefined;

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: opts.name,
    description: opts.description,
    url: absoluteUrl(opts.url),
    image: absoluteUrl(opts.image),
    manufacturer: { '@id': ORG_ID },
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.brand ? { brand: { '@type': 'Brand', name: opts.brand } } : {}),
    ...(opts.features?.length
      ? {
          additionalProperty: opts.features.map((f) => ({
            '@type': 'PropertyValue',
            name: f.name,
            value: f.value,
          })),
        }
      : {}),
    ...(offers ? { offers } : {}),
  };
}

/** Service — for service pages (замер, монтаж, доставка …). */
export function serviceSchema(opts: {
  name: string;
  description: string;
  url: string;
  areaServed?: string;
}): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: opts.name,
    description: opts.description,
    url: absoluteUrl(opts.url),
    provider: { '@id': ORG_ID },
    areaServed: {
      '@type': 'City',
      name: opts.areaServed ?? SITE.address.locality,
    },
  };
}

/** ItemList — for catalog index pages (list of category/product cards). */
export function itemListSchema(opts: {
  name: string;
  items: { name: string; url: string; image?: string; position?: number }[];
}): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: opts.name,
    itemListElement: opts.items.map((item, i) => ({
      '@type': 'ListItem',
      position: item.position ?? i + 1,
      name: item.name,
      url: absoluteUrl(item.url),
      ...(item.image ? { image: absoluteUrl(item.image) } : {}),
    })),
  };
}

/** Article / BlogPosting — for blog posts. */
export function articleSchema(opts: {
  title: string;
  description: string;
  url: string;
  image?: string;
  datePublished: string | Date;
  dateModified?: string | Date;
  author?: string;
}): Json {
  const iso = (d: string | Date) => (typeof d === 'string' ? d : d.toISOString());
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: opts.title,
    description: opts.description,
    url: absoluteUrl(opts.url),
    mainEntityOfPage: absoluteUrl(opts.url),
    ...(opts.image ? { image: absoluteUrl(opts.image) } : {}),
    datePublished: iso(opts.datePublished),
    dateModified: iso(opts.dateModified ?? opts.datePublished),
    author: { '@type': 'Organization', name: opts.author ?? SITE.name },
    publisher: {
      '@type': 'Organization',
      name: SITE.name,
      logo: { '@type': 'ImageObject', url: absoluteUrl('/logo.png') },
    },
  };
}
