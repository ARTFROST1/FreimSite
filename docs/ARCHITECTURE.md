# Архитектура и соглашения

Карта проекта: где что лежит, как это связано и по каким правилам расширять.

---

## Дерево проекта

```
astro-starter/
├── astro.config.mjs          # SITE_URL, режим (static/server), sitemap, mdx, tailwind
├── tsconfig.json             # strict + alias @/* → src/*
├── package.json              # скрипты и зависимости
├── frostdeploy.json          # контракт с панелью деплоя (kind, build, output)
├── content.schema.json       # ★ КОНТРАКТ с CMS-порталом (генерируется, коммитится)
├── .env.example              # шаблон переменных окружения
├── .nvmrc                    # Node 22
│
├── public/                   # статика «как есть» (не проходит сборку)
│   ├── robots.txt
│   ├── site.webmanifest
│   ├── favicon.svg           # знак + .ico/.png-дубли и icons/ — всё из `npm run build:icons`
│   ├── logo.png              # логотип организации для Schema.org (512, с фоном)
│   ├── fd-edit.js            # оверлей визуального редактора (только в iframe портала)
│   ├── icons/                # PWA-иконки 192/512 + maskable
│   ├── images/               # placeholder.svg + легаси-файлы (контент живёт в src/assets/)
│   ├── fonts/                # self-hosted WOFF2 (см. README внутри)
│   └── og/                   # OG-картинки 1200×630 (см. README внутри)
│
├── scripts/
│   ├── indexnow-notify.mjs   # postbuild: пинг IndexNow (Yandex/Bing)
│   ├── generate-content-schema.ts  # ★ prebuild: COLLECTIONS → content.schema.json
│   ├── optimize-images.mjs   # пережатие картинок (не трогает src/assets/cms)
│   ├── find-orphan-assets.mjs      # неиспользуемые загрузки клиента
│   └── __tests__/            #   annotations (rot-guard data-cms), fd-edit, схема, картинки
│
├── src/
│   ├── assets/               # ★ контентные картинки под astro:assets (webp, srcset, хеш)
│   │   ├── cms/              #   загрузки клиента через портал — руками не трогать
│   │   ├── gallery/          #   галерея /gallery/ (реестр подхватывает автоматически)
│   │   └── hero|sections|showcase|blog/
│   │
│   ├── config/               # ★ настройки проекта (правит разработчик)
│   │   ├── site.ts           #   SITE — единый источник правды о бизнесе
│   │   ├── nav.ts            #   структура меню/футера/CTA (подписи — в контенте)
│   │   ├── seo.ts            #   SEO — мета по каждой странице
│   │   └── schemas.ts        #   Zod-схемы контента → типы + валидация + формы CMS
│   │
│   ├── lib/                  # чистая логика (без разметки)
│   │   ├── utils.ts          #   cn, formatPrice, formatDate, phoneHref, readingTime
│   │   ├── analytics.ts      #   METRIKA_ID, GOALS, reachGoal()
│   │   ├── utm.ts            #   UTM/yclid/gclid + getClientId (3-уровневый каскад)
│   │   ├── lead-form.ts      #   движок лид-форм: маска +7, отправка, цели
│   │   ├── json-ld.ts        #   serializeJsonLd — безопасная сериализация JSON-LD
│   │   ├── images/           #   registry.ts (реестр src/assets) + resolve.ts (ключ → рендер)
│   │   └── schema.ts         #   JSON-LD: Organization, LocalBusiness, Product,
│   │                         #   Service, ItemList, FAQ, Breadcrumb, Article (@id-связи)
│   │
│   ├── layouts/
│   │   ├── BaseLayout.astro  #   <head>, мета, SEO, аналитика, chrome (Header/Footer)
│   │   └── BlogLayout.astro  #   обёртка для статей блога (+ BlogPosting JSON-LD)
│   │
│   ├── components/
│   │   ├── layout/           #   Header, Footer (0 JS, vanilla-меню)
│   │   ├── sections/         #   секции-скелеты (0 JS) + PageHero; варианты — пропом variant/layout
│   │   ├── seo/              #   JsonLd, Breadcrumbs
│   │   ├── analytics/        #   YandexMetrika, AnalyticsRouterHit, UTMTracker,
│   │   │                     #   ConversionTracking (href-автодетект + data-goal),
│   │   │                     #   EngagementTracking (engaged/deep_scroll)
│   │   ├── common/           #   MobileStickyCTA, CookieConsent, Lightbox,
│   │   │                     #   LeadPopup, PromoBanner, Modal (<dialog>), Toast
│   │   ├── blog/             #   BlogCard, BlogListing (общий список для /blog/ и /blog/page/N/)
│   │   └── ui/               #   Astro: ContentImage, LeadForm, YandexMap, GalleryGrid,
│   │                         #   Marquee, ComparisonTable, TableOfContents, Tabs,
│   │                         #   Carousel, VideoEmbed, BeforeAfter, Tooltip, Dropdown,
│   │                         #   Pagination (см. docs/recipes/ui-components.md)
│   │                         #   React-острова (.tsx): ContactForm, ImageGallery
│   │
│   ├── content.config.ts     # ★ описание всех коллекций (в корне src/, не в content/)
│   ├── content/              # ★ КОНТЕНТ — то, что правит клиент через CMS
│   │   ├── home/*.json       #   блоки главной: hero, sections, features, reviews,
│   │   │                     #   pricing, faq, rating, showcase, team, stats,
│   │   │                     #   partners, timeline
│   │   ├── nav/*.json        #   сквозное: navigation, footer, address
│   │   ├── pages/pages.json  #   тексты страниц about/contacts/gallery
│   │   └── blog/*.{md,mdx}   #   статьи: .md — клиент через портал, .mdx — разработчик
│   │
│   ├── pages/                # файловая маршрутизация
│   │   ├── index.astro       #   /
│   │   ├── about.astro       #   /about/
│   │   ├── gallery.astro     #   /gallery/
│   │   ├── contacts.astro    #   /contacts/
│   │   ├── thanks.astro      #   /thanks/
│   │   ├── blog/index.astro  #   /blog/
│   │   ├── blog/[slug].astro #   /blog/<slug>/
│   │   ├── privacy-policy.astro, terms.astro, 404.astro
│   │   ├── rss.xml.ts        #   /rss.xml
│   │   └── api/contact.ts.example   # SSR-эндпоинт (переименовать для активации)
│   │
│   ├── styles/global.css     # @theme (дизайн-токены) + базовые + компонент-классы
│   └── env.d.ts              # типы переменных окружения
│
└── docs/                     # эта документация
```

★ — файлы, которые вы трогаете чаще всего при запуске нового сайта.

---

## Слоистая модель

```
config/  →  данные (что показать)          ← правите под каждый проект
  │
lib/     →  логика (как посчитать/собрать)  ← переиспользуемая, редко меняется
  │
components/sections/  →  разметка (как выглядит)
  │
layouts/  →  каркас страницы (<head>, chrome)
  │
pages/   →  маршруты (что где живёт)
```

Правило: **компоненты не хардкодят бизнес-данные**. Секция берёт данные из
`config/` (через импорт или props) и только раскладывает их. Поэтому один и тот
же скелет секции переиспользуется на разных сайтах — меняются данные, не код.

---

## Astro vs React: когда остров

Островная архитектура: по умолчанию всё — статический HTML (0 KB JS). React
подключается только для реальной интерактивности, через директиву гидратации в
`.astro`-файле (не в `.tsx`).

| Задача | Решение |
| --- | --- |
| Текст, картинки, секции, футер | `.astro`, 0 JS |
| SEO-разметка, JSON-LD | `.astro`, 0 JS |
| Меню-бургер, аккордеон FAQ, sticky-CTA | `.astro` + маленький `is:inline` vanilla-скрипт |
| Форма с валидацией и отправкой | React-остров `client:visible` |
| Лайтбокс галереи | React-остров `client:visible` |

Директивы гидратации:
- `client:load` — сразу (только для критичной above-the-fold интерактивности)
- `client:visible` — при попадании в вьюпорт (по умолчанию для форм/галерей)
- `client:idle` — когда браузер свободен
- `client:media="(...)"` — по media-запросу

Подробнее — `docs/PERFORMANCE.md`.

---

## Соглашения по именованию

| Тип | Стиль | Пример |
| --- | --- | --- |
| Astro-компоненты | PascalCase | `HeroSection.astro` |
| React-острова | PascalCase | `ContactForm.tsx` |
| Утилиты/конфиги TS | kebab/lowerCamel | `analytics.ts`, `site.ts` |
| Статьи блога | kebab-case (= URL) | `lago-naki-guide.md` / `.mdx` |
| Папки | kebab-case | `components/sections/` |

Прочее:
- Все внутренние ссылки — со слэшем в конце (`/about/`), т.к. `trailingSlash: 'always'`.
- Директива `client:*` ставится в родительском `.astro`, а не в `.tsx`.
- Цвета — только через токены (`bg-accent`, `text-ink`), без хардкода hex в разметке.
- Цели аналитики — через `data-goal="..."` в разметке или `reachGoal()` в скрипте острова.

---

## Как добавить…

**…новую страницу:** создайте `src/pages/имя.astro`, оберните в `BaseLayout`,
добавьте запись в `src/config/seo.ts` и, при необходимости, пункт в `nav.ts`.

**…новую секцию:** создайте `src/components/sections/Имя.astro`, данные берите из
контент-коллекции (`getCollection('features')`) или из props. Импортируйте
в нужную страницу. Как завести новую коллекцию — `docs/CONTENT.md`.

**…новый остров:** создайте `src/components/ui/Имя.tsx`, подключите в `.astro` с
`client:visible` (или другой директивой). Держите бандл маленьким.

**…новую коллекцию контента** (например, «услуги» или «кейсы»): пошаговая
цепочка — [`docs/CMS-BUILDING.md`](CMS-BUILDING.md); решение «это вообще
контент или конфиг?» — [`docs/CONTENT.md`](CONTENT.md).

**…новый тип структурированных данных:** добавьте генератор в `src/lib/schema.ts`
и выведите через `<JsonLd schema={...} />`.

⚠️ **Любой блок, который должен править клиент**, добавляется не «просто
компонентом», а по полной цепочке из **[`docs/CMS-BUILDING.md`](CMS-BUILDING.md)**
(схема → контент → коллекция → контракт `content.schema.json` → `data-cms` в
разметке → рот-гвард в тесте). Пропущенный шаг = блок, который выглядит рабочим,
но недоступен клиенту в портале. Сборка сайта с нуля по прототипу —
**[`docs/AGENT-PLAYBOOK.md`](AGENT-PLAYBOOK.md)**.
