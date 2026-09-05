# SEO

> ⚠️ Перед настройкой аналитики и форм прочитайте
> [ANALYTICS-PITFALLS.md](ANALYTICS-PITFALLS.md) — разбор ошибок,
> которые уже стоили боевому проекту конверсий и 85% данных.

Шаблон закрывает техническое SEO из коробки: мета-теги, canonical, структурированные
данные (JSON-LD), sitemap, robots, RSS и быстрый переобход через IndexNow. Ниже —
как всё устроено и что заполнить.

Всё SEO-производное выводится из одной константы `SITE_URL` в `astro.config.mjs`
и объекта `SITE` в `src/config/site.ts`. Меняйте их в первую очередь.

---

## 1. Мета-теги страниц

Тексты страниц живут в `src/config/seo.ts` — record `SEO` с полями на каждую
страницу: `{ title, description, keywords?, ogTitle?, ogDescription?, ogImage? }`.

Страница передаёт их в `BaseLayout.astro`, который формирует весь `<head>`:

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import { SEO } from '../config/seo';
const seo = SEO.about;
---
<BaseLayout title={seo.title} description={seo.description} keywords={seo.keywords}>
  …
</BaseLayout>
```

Правила по длине:
- **title** — 50–60 символов (иначе обрежется в выдаче);
- **description** — 140–160 символов (в схеме blog она вообще ограничена `max(160)`).

`BaseLayout` также умеет `noindex` (ставит `<meta name="robots" content="noindex, nofollow">`)
— используется на страницах-заглушках privacy/terms и на страницах вроде
«спасибо за заявку» или внутренних инструментов. Важно: как только правовые
страницы наполнены реальным текстом, `noindex` с них надо **снять** и вернуть
их в sitemap — политика конфиденциальности обязана быть в открытом доступе
(ч. 2 ст. 18.1 152-ФЗ), см. [LEGAL](LEGAL.md).

---

## 2. Canonical и trailingSlash

- `trailingSlash: 'always'` в конфиге → все URL заканчиваются слэшем.
- Все внутренние ссылки пишите со слэшем: `href="/about/"`, `/blog/[slug]/`.
- `BaseLayout` ставит `<link rel="canonical">` на текущий URL (или на
  переданный проп `canonical`). Несогласованность слэшей = дубли в индексе,
  поэтому держите ссылки единообразными.

---

## 3. Структурированные данные (JSON-LD)

Билдеры схем — в `src/lib/schema.ts`. Что и где эмитится:

| Где | Схема | Источник |
|-----|-------|----------|
| `BaseLayout` (все страницы) | **Organization** + **BreadcrumbList** (авто из `breadcrumbs`) | `organizationSchema()`, `breadcrumbSchema()` |
| Главная (`index.astro`) | **WebSite** + **LocalBusiness** | `webSiteSchema()`, `localBusinessSchema()` |
| Пост блога (`BlogLayout`) | **BlogPosting/Article** | `articleSchema()` |
| Секция FAQ (`FAQSection`) | **FAQPage** | `faqSchema()` |

**Только реальные данные.** Рейтинг/отзывы (`aggregateRating`) отдавайте, только
если они настоящие. Рейтинг лежит в `src/content/home/rating.json`
(`{ value, count }`), и по умолчанию `count: 0`. Главная страница передаёт
рейтинг в `LocalBusiness` только при `RATING.count > 0`:

```js
localBusinessSchema(
  RATING.count > 0 ? { rating: RATING.value, reviewCount: RATING.count } : undefined
)
```
Фейковый `aggregateRating` — прямое нарушение правил Google и Яндекса и грозит
санкциями. Не заполняйте, пока нет реальных отзывов.

**Валидация:**
- Schema.org validator — `https://validator.schema.org`
- Google Rich Results Test — `https://search.google.com/test/rich-results`

Проверяйте каждый тип страницы (главная, пост, FAQ) после наполнения.

---

## 4. Sitemap, robots, RSS

- **Sitemap** — интеграция `@astrojs/sitemap`, генерируется автоматически при сборке
  в `sitemap-index.xml`. В `astro.config.mjs` в `serialize()` задан приоритет и
  `changefreq` по типу маршрута: главная `1.0`, листинг блога `0.7`, пост `0.6`,
  privacy/terms `0.3`. Служебные роуты (`/api/`, `/admin`, `/404`) исключены `filter`.
- **robots.txt** — `public/robots.txt`. Обновите строку `Sitemap:` на реальный
  домен (должна совпадать с `site`).
- **RSS** — `src/pages/rss.xml.ts`, ссылка на фид проставлена в `<head>` BaseLayout.

---

## 5. IndexNow — быстрый переобход (Яндекс + Bing)

`scripts/indexnow-notify.mjs` запускается как `postbuild`: читает sitemap из `dist`
и пингует Яндекс и Bing об изменившихся URL. **No-op**, если `INDEXNOW_KEY` не задан
(сборка не ломается).

Включение:
```bash
KEY=$(openssl rand -hex 16)
echo "$KEY" > public/$KEY.txt      # ключ-файл в public/
echo "INDEXNOW_KEY=$KEY" >> .env   # и в окружение (CI-secret на проде)
```
Файл `public/<key>.txt` должен отдаваться по `https://ВАШ-ДОМЕН/<key>.txt` —
скрипт указывает на него в `keyLocation`.

---

## 6. Специфика Яндекса

- **Яндекс.Вебмастер:** подтвердите права (meta-тег через `<slot name="head" />`
  в `BaseLayout` или verification-файл в `public/`), затем добавьте sitemap.
- **Гео-мета для локального SEO:** `BaseLayout` уже выводит `geo.region`,
  `geo.placename`, `geo.position`, `ICBM` из `SITE.address`/`SITE.geo` — заполните
  их в `src/config/site.ts`. Плюс `LocalBusiness` JSON-LD с адресом и координатами.
- **Метрика:** задайте `PUBLIC_YANDEX_METRIKA_ID` в `.env` (пусто = трекинг выключен,
  см. `src/lib/analytics.ts`). Цели конверсий — в реестре `GOALS`. Счётчик
  работает по SPA-схеме (`defer` + ручные хиты), tag.js грузится после согласия
  в cookie-баннере (152-ФЗ, `PUBLIC_METRIKA_CONSENT_GATE=0` отключает гейт).
  Пошаговая настройка интерфейса Метрики —
  [docs/recipes/metrika-guide.md](recipes/metrika-guide.md).

---

## 7. OG / Twitter изображения

- Размер **1200×630** px.
- Дефолт — `SITE.ogImage`; на страницу можно переопределить `ogImage` в `SEO`.
- Кладите картинки в `public/og/` (сейчас там только README-заглушка).
- `BaseLayout` формирует полный набор OG и Twitter-тегов (`og:title`, `og:image`,
  `twitter:card` и т.д.).

---

## 8. SEO контента / блога

- Уникальные `title` и `description` на каждый пост (frontmatter поста, схема Zod
  в `src/content.config.ts`, `description` ≤ 160 символов).
- Один `<h1>` на страницу, логичная иерархия `h2`/`h3`.
- **Внутренняя перелинковка:** ссылки между постами и на посадочные страницы.
- `image` + `imageAlt` в frontmatter поста — alt обязателен для картинок.
- Slug поста = имя файла (`post.id`) — задавайте осмысленные имена файлов.

---

## 9. Чек-лист перед запуском

- [ ] `SITE_URL`, `SITE.url`, `robots.txt` → реальный домен, нигде нет `example.com`.
- [ ] `SITE` заполнен: name, контакты, адрес, `geo`, соцсети, `ogImage`.
- [ ] `SEO`-тексты на все страницы (title 50–60, description 140–160).
- [ ] OG-картинки 1200×630 в `public/og/`.
- [ ] JSON-LD проверен в validator.schema.org и Rich Results Test.
- [ ] `aggregateRating` только при реальных отзывах (`RATING.count > 0`).
- [ ] Sitemap открывается, отправлен в Яндекс.Вебмастер и Google Search Console.
- [ ] IndexNow-ключ сгенерирован и подключён (при необходимости).
- [ ] Метрика подключена, цели проверены.
- [ ] У постов блога уникальные мета, alt у картинок, внутренние ссылки.
