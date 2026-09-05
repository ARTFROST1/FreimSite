import { defineCollection } from 'astro:content';
import { file, glob } from 'astro/loaders';
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
} from './config/schemas';

/** Blog: `.md` правит клиент через портал, `.mdx` — разработчицкие статьи
 *  с компонентами; порталу они невидимы (контракт объявляет ext '.md').
 *  Спека: FrostDeploy docs/superpowers/specs/2026-09-05-blog-entries-design.md */
const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: blogPostSchema,
});

/**
 * ---------------------------------------------------------------------------
 *  HOME-PAGE CONTENT — one collection per editable block.
 * ---------------------------------------------------------------------------
 *  Each maps 1:1 to a CMS collection, so an editor sees "Преимущества",
 *  "Отзывы", "Тарифы", "Вопросы" as separate screens rather than one blob.
 *
 *  ORDER IS FILE ORDER. `file()` keeps entries in the order they appear in the
 *  JSON array, so dragging a row in a CMS list widget rewrites the array and
 *  reorders the page. That is why there is no `order:` field to maintain.
 * ---------------------------------------------------------------------------
 */

const features = defineCollection({
  loader: file('src/content/home/features.json'),
  schema: featureSchema,
});

const reviews = defineCollection({
  loader: file('src/content/home/reviews.json'),
  schema: reviewSchema,
});

const pricing = defineCollection({
  loader: file('src/content/home/pricing.json'),
  schema: pricingPlanSchema,
});

const faq = defineCollection({
  loader: file('src/content/home/faq.json'),
  schema: faqItemSchema,
});

/**
 * Singleton, so the file is an object keyed by id rather than an array:
 * `file()` accepts "an array of objects that contain unique `id` fields, or an
 * object with string keys". The only key here is `aggregate`.
 */
const rating = defineCollection({
  loader: file('src/content/home/rating.json'),
  schema: ratingSchema,
});

/** Singletons like `rating`: object files keyed by a single id (`main`). */
const hero = defineCollection({
  loader: file('src/content/home/hero.json'),
  schema: heroSchema,
});

const sections = defineCollection({
  loader: file('src/content/home/sections.json'),
  schema: sectionTextsSchema,
});

/** Home-page slide deck for <StackedShowcase />. Array, ordered by file(). */
const showcase = defineCollection({
  loader: file('src/content/home/showcase.json'),
  schema: showcaseSlideSchema,
});

/** <TeamSection /> — people cards. Array, ordered by file(). */
const team = defineCollection({
  loader: file('src/content/home/team.json'),
  schema: teamMemberSchema,
});

/** <StatsSection /> — animated number facts. Array, ordered by file(). */
const stats = defineCollection({
  loader: file('src/content/home/stats.json'),
  schema: statSchema,
});

/** <LogosSection /> — partner/client logos («нам доверяют»). Array. */
const partners = defineCollection({
  loader: file('src/content/home/partners.json'),
  schema: partnerSchema,
});

/** <TimelineSection /> — company milestones. Array, ordered by file(). */
const timeline = defineCollection({
  loader: file('src/content/home/timeline.json'),
  schema: timelineItemSchema,
});

/**
 * ---------------------------------------------------------------------------
 *  SITE CHROME + OTHER PAGES — content that isn't home-page-specific.
 * ---------------------------------------------------------------------------
 *  `navigation`/`footer`/`address` live in src/content/nav/ (header, footer,
 *  and the site-wide display address are edited together as "site chrome").
 *  `pages` lives in src/content/pages/ (per-page hero copy for about/
 *  contacts/gallery — pages without a home-style `sections` singleton).
 * ---------------------------------------------------------------------------
 */
const navigation = defineCollection({
  loader: file('src/content/nav/navigation.json'),
  schema: navigationSchema,
});

const footer = defineCollection({
  loader: file('src/content/nav/footer.json'),
  schema: footerSchema,
});

const address = defineCollection({
  loader: file('src/content/nav/address.json'),
  schema: addressSchema,
});

/** Юридические факты оператора (реквизиты, ФИО ответственного, даты редакций,
 *  уведомление РКН) — их печатают три правовых документа, и правит их клиент
 *  в портале. Что сюда НЕ попало и почему — доккоммент `legalSchema`. */
const legal = defineCollection({
  loader: file('src/content/legal/legal.json'),
  schema: legalSchema,
});

const pages = defineCollection({
  loader: file('src/content/pages/pages.json'),
  schema: pagesSchema,
});

/**
 * ---------------------------------------------------------------------------
 *  CATALOG — categories (flat array with `parent`) and products (one MDX per
 *  item under src/content/products/).
 * ---------------------------------------------------------------------------
 */
const categories = defineCollection({
  loader: file('src/content/catalog/categories.json'),
  schema: categorySchema,
});

const products = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/products' }),
  schema: productSchema,
});

export const collections = {
  blog,
  features,
  reviews,
  pricing,
  faq,
  rating,
  hero,
  sections,
  showcase,
  team,
  stats,
  partners,
  timeline,
  navigation,
  footer,
  address,
  legal,
  pages,
  categories,
  products,
};
