# Рецепты — проверенные боем решения

Каждый рецепт — паттерн, реально работающий в продакшене на двух эталонных
проектах: **эталон-витрина** (одностраничный сайт с бронированием) и
**эталон-каталог** (каталог с лидогеном). Часть перенесена в стартер готовым
кодом; для остального рецепт описывает, как построить решение по образцу и где
смотреть референс.

**Рецепты — надстройка, а не замена базы.** Базовое поведение шаблона описано в
профильных документах ([IMAGES](../IMAGES.md), [SEO](../SEO.md),
[PERFORMANCE](../PERFORMANCE.md), [CMS-BUILDING](../CMS-BUILDING.md)); здесь —
только то, что делается **поверх** них. Если рецепт и профильный документ
расходятся, прав профильный: правьте его, а рецепт приводите в соответствие.

| Рецепт | О чём | В стартере кодом? |
| --- | --- | --- |
| [lead-pipeline.md](lead-pipeline.md) | Лид-пайплайн v2: двухшаговая форма → черновики → флашер → боты TG/MAX → офлайн-конверсии | ✅ lead-form.ts, lead-server, server/lead-flusher.mjs, bots/, api/lead/*.example |
| [monitoring.md](monitoring.md) | Мониторинг сайта и ботов: `/api/health/`, UptimeRobot, внутренний watchdog telegram-бота | ✅ health_watchdog в bots/telegram/bot.py |
| [manager-guide.md](manager-guide.md) | Шаблон гайда менеджера заказчика: карточка заявки, кнопки квалификации | 📖 шаблон (заполнить плейсхолдеры) |
| [yandex-map.md](yandex-map.md) | Яндекс.Карта: lazy JS API + tap-guard + iframe-фолбэк | ✅ YandexMap.astro |
| [popups-engagement.md](popups-engagement.md) | Попапы и вовлечение: триггеры, cooldown, exit-intent, промо-баннер | ✅ LeadPopup, PromoBanner (база) |
| [conversion-attribution.md](conversion-attribution.md) | Сквозная атрибуция: UTM → client_id → офлайн-конверсии | ✅ utm.ts, трекеры (база) |
| [metrika-guide.md](metrika-guide.md) | Настройка счётчика Метрики руками: создание, цели, Вебвизор, проверка | 📖 инструкция к коду analytics/* |
| [metrika-oauth-client-instruction.txt](metrika-oauth-client-instruction.txt) | Готовый текст КЛИЕНТУ: как выпустить OAuth-токен для офлайн-конверсий в своём аккаунте | 📨 отправляется как есть (.txt намеренно — разметка в мессенджерах ломается) |
| [webmaster-gsc-guide.md](webmaster-gsc-guide.md) | Регистрация сайта в Яндекс.Вебмастере и GSC: пошагово, проверки, отчёты | 📖 инструкция |
| [structured-data-guide.md](structured-data-guide.md) | Структурированная разметка: что размечаем, правила 2026, валидация | 📖 инструкция к lib/schema.ts |
| [external-widgets.md](external-widgets.md) | Сторонние виджеты (бронирование и т.п.): загрузка, рескин, конверсии | 📖 рецепт |
| [catalog-seo.md](catalog-seo.md) | Каталог с programmatic SEO: 3 уровня страниц, Product/ItemList schema | ⚙️ schema-билдеры + рецепт |
| [product-feeds.md](product-feeds.md) | Товарные фиды YML + Google Merchant XML: каналы, канон о ценах, таксономия, грабли | ✅ yml.xml + google-merchant.xml, feeds.ts/price.ts/catalog-taxonomy.ts + рецепт |
| [photo-archive.md](photo-archive.md) | Фотоархив клиента → каталог: pHash-дедуп, слои image/slider/gallery, сортировщик /sortirovka/, генерация обложек | ✅ media-конвейер (scripts/media.config.mjs + media:*) |
| [animations-motion.md](animations-motion.md) | Анимации: data-reveal, SPA-safe скрипты, marquee, тёмные зоны | ✅ reveal-система, Marquee |
| [border-glow.md](border-glow.md) | **Кант света**: живая светящаяся рамка карты — свет едет по периметру (и на тач тоже), на ховере уходит к курсору. Кольцо тенью + статичная маска-«окно», движение только трансформами; механика на одном числе | 📖 рецепт с готовым кодом (референс — Creative Solution) |
| [ui-components.md](ui-components.md) | UI-примитивы: Modal, Toast, Tabs, Carousel, VideoEmbed, BeforeAfter, Tooltip, Dropdown, Pagination — справочник, SPA-паттерны (делегирование, портал в body, scroll-lock), атрибуция источников | ✅ common/Modal, Toast; ui/Tabs, Carousel, VideoEmbed, BeforeAfter, Tooltip, Dropdown, Pagination; lib/positioning, video-embed, pagination |
| [scroll-scenes.md](scroll-scenes.md) | Пин-сцена со скрабом по кадрам: раскадровка, обратимость, бюджет загрузки | ✅ ScrollScene + frames-from-video.mjs |
| [anchor-navigation.md](anchor-navigation.md) | **Якорная навигация: как делать правильно** — готовая пара модулей, контракт, 12 правил с ценой нарушения, приёмочный стенд | ✅ scroll-to.ts + anchor-nav.ts + audit:anchors |
| [scroll-pitfalls.md](scroll-pitfalls.md) | Грабли скролла: восстановление позиции по ориентиру, ScrollTrigger vs sticky, smooth-scroll, window-слушатели на пер-страничном DOM | 📖 знания (пригождаются при GSAP ScrollTrigger/history-скролле) |
| [images-assets.md](images-assets.md) | Изображения **сверх базы**: LQIP, детали пережатия, уровни lazy, OG (система целиком — [IMAGES.md](../IMAGES.md)) | ⚙️ optimize-images.mjs + рецепт |
| [admin-panel.md](admin-panel.md) | Админ-панель: деплой-кнопка, метрики, логи, трафик | 📖 рецепт |
| [gotchas.md](gotchas.md) | Грабли: собранные баги обоих проектов, чтобы не наступать повторно | 📖 справочник |

Легенда: ✅ — готовый код в стартере; ⚙️ — частично (инструмент + инструкция);
📖 — только инструкция (паттерн слишком проектно-зависим для шаблона);
🚧 — решение зафиксировано, кода ещё нет.

## Сквозные принципы (важнее любого отдельного рецепта)

1. **SPA-safe скрипты.** Стартер использует View Transitions (`<ClientRouter/>`),
   значит каждый инлайн-скрипт обязан переживать навигацию:
   - документ-уровневые слушатели вешаются ОДИН раз под флагом
     `if (window.__fooInit) return; window.__fooInit = true;`
   - пер-страничная привязка к DOM — в обработчике `astro:page-load`
     (он срабатывает и при первой загрузке);
   - таймеры/обсерверы очищаются перед перевзведением, иначе после
     навигаций они копятся (двойная скорость каруселей — классика).

2. **IntersectionObserver-гейтинг.** Ничего не тикает вне вьюпорта: карусели,
   слайд-шоу, карта, цели аналитики — всё стартует по наблюдателю.

3. **`prefers-reduced-motion` всегда.** Любая анимация имеет reduce-ветку.

4. **Аналитика не ломает UX.** Все вызовы `ym`/`trackConversion` в try/catch
   и с проверкой наличия; сайт полностью работает с выключенной аналитикой.

5. **Storage с try/catch.** `localStorage`/`sessionStorage` бросают в приватном
   режиме — каждый доступ обёрнут.
