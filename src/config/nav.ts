/**
 * Navigation model — consumed by Header, Footer and the SiteNavigation
 * JSON-LD. Keep labels short. `href` values are trailing-slashed to match
 * `trailingSlash: 'always'`.
 *
 * Labels are structural defaults only. The actually-displayed text for
 * Header/Footer comes from the `navigation`/`footer` CMS collections
 * (src/content/nav/*.json, see src/config/schemas.ts) keyed by the stable
 * `id` below — hrefs never move, only labels are CMS-editable. Other,
 * not-yet-wired consumers (404 page, blog layout, mobile sticky CTA) still
 * read `.label` here directly; see docs/CMS-BUILDING.md for the full map.
 */

/** Ids used by Header's desktop + mobile nav — must match `navigation.menu`
 *  keys in src/config/schemas.ts. Never rename; add a new id instead. */
export type NavMenuId = 'about' | 'services' | 'gallery' | 'catalog' | 'blog' | 'contacts';

export interface NavItem {
  id: NavMenuId;
  /** Structural default. Header.astro overrides this with the CMS label. */
  label: string;
  href: string;
}

/** Primary header navigation. */
export const NAV_MAIN: NavItem[] = [
  { id: 'about', label: 'О нас', href: '/about/' },
  { id: 'services', label: 'Услуги', href: '/#features' },
  { id: 'gallery', label: 'Галерея', href: '/gallery/' },
  { id: 'catalog', label: 'Каталог', href: '/katalog/' },
  { id: 'blog', label: 'Блог', href: '/blog/' },
  { id: 'contacts', label: 'Контакты', href: '/contacts/' },
];

/** Ids used by Footer's two link columns — must match `footer.columns.*.links`
 *  keys in src/config/schemas.ts. */
export type FooterSectionLinkId = 'home' | 'about' | 'gallery' | 'blog' | 'contacts';
export type FooterLegalLinkId = 'privacy' | 'consent' | 'terms';

/**
 * Footer link columns — structural only (id + href). Labels are 100%
 * CMS-editable via the `footer` singleton; Footer.astro is the only
 * consumer, so there is no hardcoded label duplicate to keep in sync.
 */
export const NAV_FOOTER = {
  sections: [
    { id: 'home', href: '/' },
    { id: 'about', href: '/about/' },
    { id: 'gallery', href: '/gallery/' },
    { id: 'blog', href: '/blog/' },
    { id: 'contacts', href: '/contacts/' },
  ] satisfies { id: FooterSectionLinkId; href: string }[],
  legal: [
    { id: 'privacy', href: '/privacy-policy/' },
    { id: 'consent', href: '/soglasie-na-obrabotku-dannykh/' },
    { id: 'terms', href: '/terms/' },
  ] satisfies { id: FooterLegalLinkId; href: string }[],
};

/** Primary call-to-action shown in header + mobile sticky bar. Label is a
 *  structural default; Header.astro overrides it with `navigation.ctaLabel`. */
export const PRIMARY_CTA: { label: string; href: string } = {
  label: 'Оставить заявку',
  href: '/contacts/',
};
