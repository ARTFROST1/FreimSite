/**
 * ============================================================================
 *  PER-PAGE SEO — one entry per route.
 * ----------------------------------------------------------------------------
 *  Rules of thumb:
 *    • title       50–60 chars, unique per page, primary keyword first,
 *                  brand at the end.
 *    • description 140–160 chars, one clear benefit + a soft call to action.
 *    • keywords    optional; modern engines mostly ignore the meta keyword
 *                  tag, so keep a small honest cluster or omit it.
 *    • og*         fall back to title/description if omitted.
 * ============================================================================
 */

export interface PageSeo {
  title: string;
  description: string;
  keywords?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
}

export const SEO: Record<string, PageSeo> = {
  home: {
    title: 'Brand Name — короткое УТП с ключевым словом',
    description:
      'Опишите главную выгоду в 140–160 символов и добавьте мягкий призыв к действию. Это описание попадёт в сниппет поисковой выдачи.',
    keywords: 'ключевое слово, услуга город, бренд',
    ogTitle: 'Brand Name — короткое УТП',
    ogDescription: 'Выгода в одну фразу для соцсетей.',
    ogImage: '/og/og-home.jpg',
  },

  about: {
    title: 'О нас — Brand Name',
    description:
      'История, ценности и команда Brand Name. Расскажите, почему клиенты выбирают именно вас, в 140–160 символов.',
    ogImage: '/og/og-about.jpg',
  },

  gallery: {
    title: 'Галерея — Brand Name',
    description:
      'Реальные фотографии работ / объекта / продукта. Покажите уровень качества до обращения.',
    ogImage: '/og/og-gallery.jpg',
  },

  contacts: {
    title: 'Контакты — адрес, телефон, как добраться | Brand Name',
    description:
      'Адрес, телефон, время работы и форма заявки Brand Name. Свяжитесь с нами удобным способом.',
    ogImage: '/og/og-contacts.jpg',
  },

  blog: {
    title: 'Блог — полезные материалы | Brand Name',
    description:
      'Статьи, гайды и новости от Brand Name. Экспертный контент, который помогает вашей аудитории и приводит трафик из поиска.',
    ogImage: '/og/og-blog.jpg',
  },

  catalog: {
    title: 'Каталог — Brand Name',
    description:
      'Каталог товаров и услуг Brand Name: категории, подборки и подробные карточки с ценами и характеристиками.',
    ogImage: '/og/og-default.jpg',
  },

  privacyPolicy: {
    title: 'Политика конфиденциальности — Brand Name',
    description:
      'Как Brand Name собирает, хранит и защищает персональные данные пользователей.',
    ogImage: '/og/og-default.jpg',
  },

  consent: {
    title: 'Согласие на обработку персональных данных — Brand Name',
    description:
      'Полный текст согласия на обработку персональных данных, которое вы даёте при отправке формы на сайте Brand Name, и порядок его отзыва.',
    ogImage: '/og/og-default.jpg',
  },

  terms: {
    title: 'Пользовательское соглашение — Brand Name',
    description: 'Условия использования сайта и услуг Brand Name.',
    ogImage: '/og/og-default.jpg',
  },
} as const;
