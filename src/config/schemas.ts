/**
 * ============================================================================
 *  CONTENT SCHEMAS — the shape of every editable block on the site.
 * ----------------------------------------------------------------------------
 *  These schemas are the single source of truth in three directions:
 *
 *    1. Astro validates the JSON in `src/content/home/` against them at build
 *       time — a typo fails the build instead of shipping a broken page.
 *    2. Section components get their types from here (`z.infer`), so renaming
 *       a field surfaces as a type error, not as `undefined` in the markup.
 *    3. A CMS generates its edit forms from them. Keep field names and
 *       descriptions human-readable: a non-technical editor reads them.
 *
 *  Why the data lives in JSON and not in a .ts file: no CMS can write
 *  TypeScript. Decap, Tina, Directus and Storyblok all read and write
 *  JSON/YAML/Markdown. Content in .ts is editable by a developer only.
 * ============================================================================
 */

import { z } from 'astro/zod';

/**
 * ----------------------------------------------------------------------------
 *  LENGTH CAPS — defence in depth for the JSON-LD / markup sinks.
 * ----------------------------------------------------------------------------
 *  Every cap here becomes `maxLength` / `maxItems` in the generated
 *  `content.schema.json`, which the CMS portal compiles with Ajv and enforces
 *  on save. That does two things:
 *
 *    1. Bounds the blast radius of any injection attempt against a text sink
 *       (see `src/lib/json-ld.ts` and audit finding H-4): an exfiltration
 *       payload needs room, and a 200-character question has none.
 *    2. Stops layout-breaking content — a 50 kB "title" is a design bug the
 *       editor cannot see coming.
 *
 *  These are LIMITS, not targets: values are ~10× the longest real copy in
 *  `src/content/**` so no legitimate edit ever hits them. Escaping at the sink
 *  is the actual XSS control; this is the belt to its braces.
 * ----------------------------------------------------------------------------
 */
const MAX = {
  /** Slugs, IDs. */
  slug: 64,
  /** Badges, eyebrows, button text, menu and link labels, phone numbers. */
  label: 120,
  /** Headings, names, questions, prices, dates, one-line address, short card copy. */
  line: 200,
  /** Subtitles, card copy, list items. */
  sentence: 500,
  /** Body paragraphs, FAQ answers, review text. */
  paragraph: 2000,
  /** An SVG `d` path (24×24) or a single emoji. */
  icon: 2000,
  /** An image registry key or a `/images/…` public path. */
  path: 300,
  /** Bullet points inside one pricing plan. */
  planFeatures: 30,

  // ── Каталог ────────────────────────────────────────────────────────────
  // У каталога свои, более тесные, каплы: карточка товара — это плитка в
  // сетке и сниппет в фиде, а не абзац. Значения ЗАФИКСИРОВАНЫ живыми
  // сайтами (контракт `content.schema.json` уже стоит у клиентов, Ajv
  // портала валидирует по нему сохранение) — имена здесь заводились, чтобы
  // убрать литералы из схем, а не чтобы пересмотреть числа. Менять число =
  // менять контракт: сначала миграция контента, потом правка.
  /** Название товара — заголовок карточки и `<h1>` страницы. */
  productTitle: 80,
  /** Название категории — заголовок плитки каталога. */
  categoryName: 60,
  /** Цена свободной строкой («от 12 500 ₽») — см. доккоммент productSchema. */
  price: 40,
  /** Один пункт списка «Особенности» товара. */
  feature: 80,
  /** Название бренда/производителя. */
  brand: 40,
  /** SEO-`<title>` — длиннее выдача обрезает. */
  metaTitle: 70,
  /** SEO-`<meta description>` — длиннее выдача обрезает. */
  metaDescription: 160,
  /** Кадров в верхнем слайдере карточки товара. */
  sliderImages: 20,
  /** Кадров в нижней секции «Галерея» карточки товара. */
  galleryImages: 30,
  /** Пунктов в списке «Особенности» одного товара. */
  productFeatures: 12,
  /** Брендов у одного товара. */
  productBrands: 8,
} as const;

/** `z.string().max(n).describe(d)` — spelled out so every field below reads
 *  as one line and no field can be added without picking a cap. */
const text = (max: number, description: string) => z.string().max(max).describe(description);

/**
 * `id` is a stable, human-meaningful slug — NOT a display value.
 * It survives reordering and renaming, so the CMS portal and the visual editor
 * can address one exact block: `features:speed:title` (the `data-cms` format —
 * see docs/CMS-BUILDING.md). Never renumber these; add new ones instead.
 *
 * `.describe()` здесь не косметика: подпись поля в форме портала — это
 * `description ?? <имя поля>`, поэтому поле без описания показывает клиенту
 * сырой английский ключ (`id`) посреди русского интерфейса. Замок —
 * `scripts/__tests__/generate-content-schema.test.ts` («каждое поле
 * контракта подписано по-русски»).
 */
const id = z
  .string()
  .min(1)
  .max(MAX.slug)
  .describe('Служебный идентификатор карточки (латиницей; менять нельзя — потеряется связь с сайтом)');

/** "Why us" / services grid. */
export const featureSchema = z.object({
  id,
  icon: text(MAX.icon, 'Иконка (SVG-путь 24×24 или один эмодзи)'),
  title: text(MAX.line, 'Заголовок преимущества'),
  description: text(MAX.sentence, 'Пояснение в одно-два предложения'),
});

export const reviewSchema = z.object({
  id,
  author: text(MAX.line, 'Имя автора отзыва'),
  rating: z.number().int().min(1).max(5).describe('Оценка 1–5; звёзды обновятся после публикации'),
  date: text(MAX.label, 'Дата отзыва (ГГГГ-ММ-ДД)'),
  text: text(MAX.paragraph, 'Текст отзыва'),
});

export const pricingPlanSchema = z.object({
  id,
  name: text(MAX.line, 'Название тарифа'),
  price: text(MAX.label, 'Цена (можно текстом, напр. "от 10 000 ₽")'),
  period: text(MAX.label, 'Период оплаты, напр. "в месяц"').optional(),
  featured: z.boolean().default(false).describe('Выделить как рекомендуемый тариф'),
  features: z
    .array(z.string().max(MAX.sentence))
    .max(MAX.planFeatures)
    .describe('Список пунктов тарифа'),
  cta: z
    .object({
      label: text(MAX.label, 'Текст кнопки'),
      href: text(MAX.path, 'Ссылка кнопки'),
    })
    .describe('Кнопка призыва к действию'),
});

export const faqItemSchema = z.object({
  id,
  question: text(MAX.line, 'Вопрос'),
  answer: text(MAX.paragraph, 'Ответ'),
});

/**
 * Aggregate rating: shown in the reviews block and fed to LocalBusiness schema.
 * Ship real numbers only — invented review data is a manual-action risk with
 * search engines. `count: 0` hides the panel instead of faking it.
 */
export const ratingSchema = z.object({
  value: z.number().min(0).max(5).describe('Средняя оценка (0–5)'),
  count: z.number().int().min(0).describe('Количество отзывов (0 скрывает блок рейтинга)'),
});

/** First screen: the headline block every visitor sees before scrolling. */
export const heroSchema = z.object({
  badge: text(MAX.label, 'Надпись над заголовком (бейдж)'),
  title: text(MAX.line, 'Главный заголовок'),
  subtitle: text(MAX.sentence, 'Подзаголовок — одно-два предложения'),
  ctaPrimary: text(MAX.label, 'Текст главной кнопки'),
  ctaSecondary: text(MAX.label, 'Текст второй кнопки'),
});

/**
 * Headings and intro copy of every home-page block. One singleton instead of
 * a field on each collection so the portal shows it as one «Тексты разделов»
 * screen and components without a collection (intro, gallery, map, cta) stay
 * editable too.
 */
export const sectionTextsSchema = z.object({
  features: z
    .object({
      eyebrow: text(MAX.label, 'Надпись над заголовком'),
      title: text(MAX.line, 'Заголовок'),
      subtitle: text(MAX.sentence, 'Подзаголовок'),
    })
    .describe('Блок «Преимущества»'),
  intro: z
    .object({
      eyebrow: text(MAX.label, 'Надпись над заголовком'),
      title: text(MAX.line, 'Заголовок'),
      body: text(MAX.paragraph, 'Абзац текста'),
    })
    .describe('Блок «О нас»'),
  gallery: z
    .object({
      eyebrow: text(MAX.label, 'Надпись над заголовком'),
      title: text(MAX.line, 'Заголовок'),
    })
    .describe('Блок «Галерея»'),
  reviews: z
    .object({
      eyebrow: text(MAX.label, 'Надпись над заголовком'),
      title: text(MAX.line, 'Заголовок'),
    })
    .describe('Блок «Отзывы»'),
  pricing: z
    .object({
      eyebrow: text(MAX.label, 'Надпись над заголовком'),
      title: text(MAX.line, 'Заголовок'),
      subtitle: text(MAX.sentence, 'Подзаголовок'),
    })
    .describe('Блок «Цены»'),
  lead: z
    .object({
      title: text(MAX.line, 'Заголовок над формой'),
      subtitle: text(MAX.sentence, 'Одна строка подводки — между заголовком и телефоном'),
      submitLabel: text(MAX.label, 'Текст кнопки формы'),
      note: text(MAX.sentence, 'Микрокопия под кнопкой (снимает страх звонка)'),
    })
    .describe('Блок «Заявка» — главная форма страницы'),
  map: z
    .object({
      eyebrow: text(MAX.label, 'Надпись над заголовком'),
      title: text(MAX.line, 'Заголовок'),
    })
    .describe('Блок «Карта и адрес»'),
  cta: z
    .object({
      title: text(MAX.line, 'Заголовок'),
      subtitle: text(MAX.sentence, 'Подзаголовок'),
    })
    .describe('Финальный призыв к действию'),
  faq: z
    .object({
      eyebrow: text(MAX.label, 'Надпись над заголовком'),
      title: text(MAX.line, 'Заголовок'),
    })
    .describe('Блок «Вопросы и ответы»'),
  team: z
    .object({
      eyebrow: text(MAX.label, 'Надпись над заголовком'),
      title: text(MAX.line, 'Заголовок'),
      subtitle: text(MAX.sentence, 'Подзаголовок'),
    })
    .describe('Блок «Команда»'),
  stats: z
    .object({
      eyebrow: text(MAX.label, 'Надпись над заголовком'),
      title: text(MAX.line, 'Заголовок'),
    })
    .describe('Блок «Цифры»'),
  partners: z
    .object({
      title: text(MAX.line, 'Заголовок'),
    })
    .describe('Блок «Нам доверяют» (логотипы партнёров)'),
  timeline: z
    .object({
      eyebrow: text(MAX.label, 'Надпись над заголовком'),
      title: text(MAX.line, 'Заголовок'),
    })
    .describe('Блок «История компании»'),
});

/**
 * Header chrome: main-nav labels, the displayed phone, and the primary CTA
 * button text. Hrefs stay structural in config/nav.ts — the CMS can relabel
 * a link, never move it. `menu` uses fixed named keys (not an array) because
 * the 5 header links are a fixed set defined by the design, not a
 * CMS-reorderable list — see docs/CMS-BUILDING.md "синглтон с фиксированными
 * полями vs массив".
 */
export const navigationSchema = z.object({
  phone: text(MAX.label, 'Номер телефона для отображения (шапка, футер, карта, контакты)'),
  ctaLabel: text(MAX.label, 'Текст кнопки «Оставить заявку» в шапке и мобильном меню'),
  menu: z
    .object({
      about: text(MAX.label, 'Пункт меню «О нас»'),
      services: text(MAX.label, 'Пункт меню «Услуги»'),
      gallery: text(MAX.label, 'Пункт меню «Галерея»'),
      catalog: text(MAX.label, 'Пункт меню «Каталог»'),
      blog: text(MAX.label, 'Пункт меню «Блог»'),
      contacts: text(MAX.label, 'Пункт меню «Контакты»'),
    })
    .describe('Подписи пунктов главного меню (ссылки менять нельзя — только текст)'),
});

/** Footer link labels + legal line. Hrefs stay structural in config/nav.ts. */
export const footerSchema = z.object({
  columns: z
    .object({
      sections: z
        .object({
          title: text(MAX.label, 'Заголовок колонки «Разделы»'),
          links: z
            .object({
              home: text(MAX.label, 'Текст ссылки «Главная» (футер)'),
              about: text(MAX.label, 'Текст ссылки «О нас» (футер)'),
              gallery: text(MAX.label, 'Текст ссылки «Галерея» (футер)'),
              blog: text(MAX.label, 'Текст ссылки «Блог» (футер)'),
              contacts: text(MAX.label, 'Текст ссылки «Контакты» (футер)'),
            })
            .describe('Подписи ссылок колонки «Разделы»'),
        })
        .describe('Колонка «Разделы»'),
      legal: z
        .object({
          title: text(MAX.label, 'Заголовок колонки «Правовое»'),
          links: z
            .object({
              privacy: text(MAX.label, 'Текст ссылки «Политика конфиденциальности»'),
              consent: text(MAX.label, 'Текст ссылки «Согласие на обработку данных»'),
              terms: text(MAX.label, 'Текст ссылки «Пользовательское соглашение»'),
            })
            .describe('Подписи ссылок колонки «Правовое»'),
        })
        .describe('Колонка «Правовое»'),
    })
    .describe('Колонки ссылок в подвале сайта'),
  copyrightSuffix: text(MAX.sentence, 'Текст после «© {год} {юрлицо}» в нижней строке футера'),
});

/**
 * Юридические ФАКТЫ оператора — то, что печатается в трёх правовых
 * документах (`/privacy-policy/`, `/soglasie-na-obrabotku-dannykh/`,
 * `/terms/`) и что клиент обязан уметь поправить сам: свои реквизиты
 * меняются без участия разработчика.
 *
 * НЕ ПУТАТЬ с `footerSchema.legal` — там подписи ссылок в подвале.
 *
 * ГРАНИЦА КОЛЛЕКЦИИ (сознательная, см. docs/platform/CONTENT.md). Сюда
 * попадают только факты, которые клиент ЗНАЕТ и МОЖЕТ ПРОВЕРИТЬ по своим
 * документам. В коде (`src/config/legal.ts`) остаются:
 *   • `operator.form` — «Индивидуальный предприниматель». Смена формы
 *     переписывает половину текста документов, это не правка поля;
 *   • `email` / `phone` / `phoneRaw` — из них строятся `mailto:`/`tel:`
 *     (правило CONTENT.md: значение, уходящее в машину, живёт в конфиге);
 *   • `actualAddress` — он уже редактируется как коллекция `address`,
 *     второй экземпляр разошёлся бы с футером;
 *   • `terms.*` — сроки ответа (10 рабочих дней) и уничтожения (30 дней)
 *     установлены 152-ФЗ, а не оператором; сроки хранения вплетены в прозу
 *     («{consentYears} (трёх) лет», `retentionDescription`) и при правке
 *     одного числа разъехались бы с текстом;
 *   • `processors.*` — описывают, что делает КОД (включён ли счётчик,
 *     подключена ли CRM). Клиент это не проверяет, а расхождение документа
 *     с реальностью — прямое нарушение, ради которого страницы и держали
 *     вне CMS.
 */
export const legalSchema = z.object({
  operator: z
    .object({
      fullName: text(MAX.line, 'ФИО предпринимателя полностью (как в ЕГРИП)'),
      inn: text(MAX.label, 'ИНН'),
      ogrnip: text(MAX.label, 'ОГРНИП'),
      registrationAddress: text(MAX.line, 'Адрес регистрации по ЕГРИП'),
    })
    .describe('Блок «Реквизиты оператора персональных данных»'),
  responsible: z
    .object({
      fullName: text(MAX.line, 'ФИО ответственного за обработку персональных данных'),
    })
    .describe('Блок «Ответственный за обработку данных» (статья 22.1 152-ФЗ)'),
  dates: z
    .object({
      privacy: text(MAX.line, 'Дата редакции Политики конфиденциальности (без «г.» на конце)'),
      consent: text(MAX.line, 'Дата редакции Согласия на обработку данных (без «г.» на конце)'),
      terms: text(MAX.line, 'Дата редакции Пользовательского соглашения (без «г.» на конце)'),
    })
    .describe('Блок «Даты редакций документов»'),
  rkn: z
    .object({
      notificationNumber: z
        .string()
        .max(MAX.label)
        .describe('Номер уведомления в реестре операторов Роскомнадзора (пусто — строка не показывается)'),
      notificationDate: z
        .string()
        .max(MAX.line)
        .describe('Дата подачи уведомления в Роскомнадзор (пусто — строка не показывается)'),
    })
    .describe('Блок «Уведомление Роскомнадзора»'),
});

/**
 * Site-wide display address (footer, contacts page, map block). Deliberately
 * separate from `config/site.ts` SITE.address.* — those individual fields
 * (country/region/locality/street/postalCode) feed LocalBusiness JSON-LD and
 * must NOT be CMS-writable (a bad edit would corrupt structured data). This
 * `full` string is a display-only convenience, never read by lib/schema.ts.
 */
export const addressSchema = z.object({
  full: text(MAX.line, 'Полный адрес одной строкой (футер, карта, страница контактов)'),
});

/**
 * Per-page hero copy for pages that don't have a home-style `sections`
 * collection of their own. One singleton (not one collection per page) so
 * the portal shows a single «Тексты страниц» screen — same rationale as the
 * home `sections` singleton.
 */
export const pagesSchema = z.object({
  about: z
    .object({
      heading: z
        .object({
          title: text(MAX.line, 'Заголовок H1'),
          subtitle: text(MAX.paragraph, 'Вводный абзац под заголовком'),
        })
        .describe('Шапка страницы — заголовок и вводный абзац'),
      intro: z
        .object({
          eyebrow: text(MAX.label, 'Надпись над заголовком'),
          title: text(MAX.line, 'Заголовок блока истории компании'),
          body: text(MAX.paragraph, 'Текст истории компании'),
        })
        .describe('Блок «История компании»'),
      values: z
        .object({
          eyebrow: text(MAX.label, 'Надпись над заголовком'),
          title: text(MAX.line, 'Заголовок блока ценностей'),
          subtitle: text(MAX.sentence, 'Подзаголовок блока ценностей'),
        })
        .describe('Блок «Ценности»'),
    })
    .describe('Страница «О нас»'),
  contacts: z
    .object({
      heading: z
        .object({
          title: text(MAX.line, 'Заголовок H1'),
          subtitle: text(MAX.paragraph, 'Вводный абзац под заголовком'),
        })
        .describe('Шапка страницы — заголовок и вводный абзац'),
    })
    .describe('Страница «Контакты»'),
  gallery: z
    .object({
      heading: z
        .object({
          title: text(MAX.line, 'Заголовок H1'),
          subtitle: text(MAX.paragraph, 'Вводный абзац под заголовком'),
        })
        .describe('Шапка страницы — заголовок и вводный абзац'),
    })
    .describe('Страница «Галерея»'),
});

/**
 * StackedShowcase slides (home page). `image` — поле-путь, редактируется
 * загрузчиком картинок портала (`.meta({ format: 'image' })` → `"format":
 * "image"` в content.schema.json).
 *
 * ЗНАЧЕНИЕ: ключ реестра `src/assets/**` без ведущего слэша (`cms/x.png`) —
 * такие картинки оптимизирует astro:assets. Значение со слэшем
 * (`/images/placeholder.svg`) отдаётся из public/ как есть. Загрузки портала
 * попадают в `src/assets/cms/` (см. `uploads` в content.schema.json).
 */
export const showcaseSlideSchema = z.object({
  id,
  title: text(MAX.line, 'Заголовок карточки'),
  description: text(MAX.sentence, 'Текст карточки'),
  image: z
    .string()
    .min(1)
    .max(MAX.path)
    .describe('Картинка слайда (загрузите файл; можно указать /images/… из public)')
    .meta({ format: 'image' }),
});

/**
 * Поле-картинка, которое МОЖНО оставить пустым: пустая строка/отсутствие →
 * компонент рисует плейсхолдер (`.ph-slot`) или текстовую плашку. Тот же
 * `format: 'image'`, что у `showcaseSlideSchema.image`, — портал показывает
 * загрузчик, значение — ключ реестра `src/assets/**` или `/images/…`.
 */
const optionalImage = (description: string) =>
  z.string().max(MAX.path).optional().describe(description).meta({ format: 'image' });

/** Команда (home). `photo` пусто → силуэт-плейсхолдер в TeamSection. */
export const teamMemberSchema = z.object({
  id,
  name: text(MAX.line, 'Имя и фамилия'),
  role: text(MAX.label, 'Должность / роль в команде'),
  bio: text(MAX.sentence, 'Пара слов о человеке (необязательно)').optional(),
  photo: optionalImage('Фото (необязательно; без фото — нейтральный силуэт)'),
});

/**
 * Цифры-факты («12 лет на рынке», «1200+ проектов»). `value` — строка, а не
 * число: клиент пишет «1200», компонент сам решает, анимировать ли счётчик
 * (CountUp только для целых чисел; «24/7» останется как есть).
 */
export const statSchema = z.object({
  id,
  value: text(MAX.label, 'Число (напр. 1200 — анимируется счётчиком; можно текстом, напр. 24/7)'),
  suffix: text(MAX.label, 'Знак после числа, напр. "+", "%", " лет" (необязательно)').optional(),
  label: text(MAX.sentence, 'Подпись под числом'),
});

/** Партнёры/клиенты для блока «Нам доверяют». `logo` пусто → плашка с именем. */
export const partnerSchema = z.object({
  id,
  name: text(MAX.line, 'Название компании'),
  logo: optionalImage('Логотип (необязательно; без файла — текстовая плашка с названием)'),
  href: text(MAX.path, 'Ссылка на сайт партнёра (необязательно)').optional(),
});

/** Вехи истории компании: «2019 — открыли первый цех». */
export const timelineItemSchema = z.object({
  id,
  date: text(MAX.label, 'Дата/метка этапа, напр. "2019" или "Май 2021"'),
  title: text(MAX.line, 'Заголовок этапа'),
  description: text(MAX.sentence, 'Что произошло — одно-два предложения'),
});

/** Категория каталога. Плоский массив; parent → двухуровневое дерево. */
export const categorySchema = z.object({
  id: z
    .string()
    .max(MAX.slug)
    // Тот же кап, что и `.max(MAX.slug)` выше — но здесь он ещё и запрещает
    // всё, кроме латиницы/цифр/дефиса: id категории уходит в URL. Литерал 64
    // в регэкспе разъехался бы с MAX.slug молча, поэтому собирается из него.
    .regex(new RegExp(`^[a-z0-9-]{1,${MAX.slug}}$`))
    .describe('Идентификатор (латиница, без пробелов; менять нельзя)'),
  name: z.string().min(1).max(MAX.categoryName).describe('Название категории'),
  description: z.string().max(MAX.line).optional().describe('Короткое описание для карточки'),
  image: z
    .string()
    .max(MAX.path)
    .optional()
    .meta({ format: 'image' })
    .describe('Картинка категории'),
  parent: z
    .string()
    .max(MAX.slug)
    .optional()
    .meta({ format: 'ref:categories' })
    .describe('Родительская категория (пусто = верхний уровень)'),
  priority: z.number().default(0).describe('Порядок (больше — выше)'),
});
export type CatalogCategory = z.infer<typeof categorySchema>;

/** Товар каталога — frontmatter записи src/content/products/<slug>.mdx. */
export const productSchema = z.object({
  title: z.string().min(1).max(MAX.productTitle).describe('Название товара'),
  category: z
    .string()
    .min(1)
    .max(MAX.slug)
    .meta({ format: 'ref:categories' })
    .describe('Категория (лист дерева)'),
  shortDescription: z.string().min(1).max(MAX.line).describe('Краткое описание для карточки'),
  // ТРИ СЛОЯ МЕДИА (урок боевого проекта, спека 2026-08-11 «Разбор фотоархива»).
  // Слой назван так же, как выглядит на странице — чтобы «галерея» не означала
  // в схеме одно, а в вёрстке другое:
  //
  //   image     обложка — карточка каталога, OG, фиды
  //   slider[]  верх карточки товара, листается миниатюрами
  //   gallery[] нижняя сворачиваемая секция «Галерея»
  //
  // Оба массива опциональны — сайт без нижней секции просто не заполняет
  // gallery, и она не рендерится; сайт с одним фото живёт на одной image.
  // Проекту с фотоархивом слои наполняет scripts/apply-media.mjs (см.
  // docs/recipes/photo-archive.md); файлы именуются cover.webp / st-NN.webp /
  // int-NN.webp — слой виден в имени, скрипты не перезапишут друг друга.
  image: z.string().min(1).max(MAX.path).meta({ format: 'image' }).describe('Обложка'),
  slider: z
    .array(z.string().max(MAX.path).meta({ format: 'image' }))
    .max(MAX.sliderImages)
    .default([])
    .describe('Слайдер: фото товара (верх карточки)'),
  gallery: z
    .array(z.string().max(MAX.path).meta({ format: 'image' }))
    .max(MAX.galleryImages)
    .default([])
    .describe('Галерея: остальные фото (нижняя секция карточки)'),
  price: z.string().max(MAX.price).optional().describe('Цена (свободный формат, напр. «от 12 500 ₽»)'),
  features: z
    .array(z.string().max(MAX.feature))
    .max(MAX.productFeatures)
    .default([])
    .describe('Особенности (по строке)'),
  brands: z
    .array(z.string().max(MAX.brand))
    .max(MAX.productBrands)
    .default([])
    .describe('Бренды/производители'),
  isHit: z.boolean().default(false).describe('Пометить как «Хит»'),
  isNew: z.boolean().default(false).describe('Пометить как «Новинка»'),
  priority: z.number().default(0).describe('Порядок в сетке (больше — выше)'),
  draft: z.boolean().default(false).describe('Черновик (не показывать на сайте)'),
  metaTitle: z.string().max(MAX.metaTitle).optional().describe('SEO-заголовок (title)'),
  metaDescription: z.string().max(MAX.metaDescription).optional().describe('SEO-описание (description)'),
});
export type CatalogProduct = z.infer<typeof productSchema>;

export type Feature = z.infer<typeof featureSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type PricingPlan = z.infer<typeof pricingPlanSchema>;
export type FaqItem = z.infer<typeof faqItemSchema>;
export type Rating = z.infer<typeof ratingSchema>;
export type Hero = z.infer<typeof heroSchema>;
export type SectionTexts = z.infer<typeof sectionTextsSchema>;
export type Navigation = z.infer<typeof navigationSchema>;
export type FooterContent = z.infer<typeof footerSchema>;
export type AddressContent = z.infer<typeof addressSchema>;
export type LegalContent = z.infer<typeof legalSchema>;
export type PagesContent = z.infer<typeof pagesSchema>;
export type ShowcaseSlide = z.infer<typeof showcaseSlideSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export type Stat = z.infer<typeof statSchema>;
export type Partner = z.infer<typeof partnerSchema>;
export type TimelineItem = z.infer<typeof timelineItemSchema>;
