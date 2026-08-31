# UI-компоненты: модалка, табы, карусель, видео-фасад, тосты, тултип, дропдаун, «до/после», пагинация

В стартере кодом (2026-08). Все — ваниль, 0 новых зависимостей, SPA-safe
под `<ClientRouter/>`, с reduce-ветками, русскими дефолтами строк через
пропы и boot-тестами (`src/components/*/__tests__/*-boot.test.ts`).
Витрина всех компонентов и их вариантов — служебная страница **`/ui-kit/`**
(noindex, вне sitemap).

Что здесь: краткий справочник по каждому компоненту (§1) и общие паттерны,
на которых они построены (§2). Каталог «что есть вообще» —
[AGENT-PLAYBOOK §9](../AGENT-PLAYBOOK.md#9-каталог-компонентов); базовый
канон SPA-safe скриптов — [animations-motion.md §2](animations-motion.md#2-spa-safe-скрипты--паттерн-без-которого-всё-ломается).
Полный doc-комментарий с обоснованием решений — в шапке каждого `.astro`;
здесь только то, что нужно, чтобы выбрать и вызвать.

## 1. Справочник

### 1.1. `common/Modal.astro` — модалка на нативном `<dialog>`

Назначение: любой диалог (акция, детали тарифа, форма в оверлее).
`showModal()` даёт фокус-трап, Escape и `::backdrop` бесплатно.

Пропы: `id` (обязателен — на него ссылаются триггеры), `title`, `size`
`sm|md|lg`, `closeLabel`, `ariaLabel` (когда нет `title`), `class`.

```astro
<button data-modal-open="promo-modal">Подробнее</button>

<Modal id="promo-modal" title="Акция месяца" size="sm">
  <p>Любой контент через slot.</p>
  <button class="btn btn-primary" data-modal-close>Понятно</button>
</Modal>
```

Программно: `document.dispatchEvent(new CustomEvent('app:modal-open',
{ detail: { id: 'promo-modal' } }))`. Закрытие — крестик, Escape, клик по
backdrop, любой `data-modal-close` внутри. Битый id триггера (CMS-превью)
— тихий no-op, в dev `console.warn`.

SPA: один набор делегированных слушателей на `document` под
`window.__modalInit`; `astro:page-load` не нужен — новые `<dialog>` из
свапнутого body подхватываются делегированием. `astro:before-swap`
закрывает открытые диалоги и снимает скролл-лок. Скролл-лок —
`body.style.overflow` по факту «есть ли `dialog[open]`» (нативный `close`
не всплывает — ловится capture-фазой). Exit-анимации нет сознательно.

### 1.2. `common/Toast.astro` — уведомления

Назначение: результат действия («Сохранено», «Ошибка отправки»).
Монтируется **один раз на сайт** (BaseLayout, рядом с CookieConsent).

Пропы: `duration` (мс, 0 — не скрывать), `maxToasts` (старые вытесняются),
`ariaLabel`, `closeLabel`, `successLabel/errorLabel/infoLabel` (sr-only
префиксы — цвет полоски не единственный носитель смысла).

```js
window.toast.success('Заявка отправлена');
window.toast.show('Проверьте телефон', { type: 'error', duration: 8000 });
// из is:inline-скриптов, которые могут выполниться раньше бандла:
document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'Готово', type: 'success' } }));
```

Контейнер `role="log"`; Escape закрывает все; hover/фокус ставят таймер на
паузу; на мобиле встаёт над `MobileStickyCTA` и cookie-полосой. Типы
`ToastApi`/`window.toast` — в `src/env.d.ts`.

SPA: API и document-слушатели под `window.__toastInit`; контейнер **не
кэшируется** — он умирает при свапе body, скрипт ищет `[data-toast-region]`
на каждый `show()`. `astro:before-swap` гасит таймеры уходящей страницы.

### 1.3. `ui/Tabs.astro` — табы по APG

Пропы: `tabs: {id, label}[]`, `initial` (id активной; по умолчанию первая),
`syncKey` (экземпляры с одним ключом переключаются вместе, выбор — в
localStorage), `label` (aria-label списка), `id` (префикс DOM-id; задавайте
явно, если на панели нужно ссылаться извне). Контент — именованные слоты
по id вкладки.

```astro
<Tabs tabs={[{ id: 'delivery', label: 'Доставка' }, { id: 'payment', label: 'Оплата' }]} initial="delivery" syncKey="delivery-info">
  <Fragment slot="delivery"><p>Привезём за 2 дня…</p></Fragment>
  <Fragment slot="payment"><p>Карта, счёт, рассрочка…</p></Fragment>
</Tabs>
```

Активная панель отрендерена сервером (краулер и no-JS видят контент
первой вкладки; остальные скрыты `hidden`, текст всё равно в HTML).
Стрелки/Home/End, автоматическая активация. DOM-id — детерминированный
хэш от id вкладок + `syncKey` со счётчиком коллизий по пути страницы
(см. [gotchas №40](gotchas.md)).

SPA: слушатели делегированы на `document` (`window.__tabsInit`);
пер-страничное — только применение сохранённого выбора при `syncKey` по
готовности DOM и на `astro:page-load`; `data-tabs-ready` защищает от
повтора.

### 1.4. `ui/Carousel.astro` — лента на scroll-snap

Пропы: `perView` `1|2|3` (десктоп ≥768px; на мобиле всегда ~1.1 слайда),
`dots`, `label` (aria-label региона), `prevLabel/nextLabel/dotLabel`.
Слайды — дети `<slot/>`. Зацикливания нет и не будет (`loop?: false`).

```astro
<Carousel label="Отзывы" perView={3} dots>
  {reviews.map((r) => <ReviewCard {...r} />)}
</Carousel>
```

Без JS — нативная scroll-snap лента; кнопки/точки показываются только с
классом `is-ready`. Плавность — `scroll-behavior: smooth` под
`no-preference`, JS зовёт `scrollTo` без `behavior`. Наружу: атрибуты
`data-can-scroll-prev/next`, `data-selected-index`, события
`carousel:init` / `carousel:select` (bubbles, `detail.index`).

SPA: `window.__carouselInit` + `window.__carouselStore`
(`Map<HTMLElement, {cleanup}>`); на каждом `astro:page-load` — cleanup
инстансов, чьи узлы уже не в `document`, и инициализация новых.

### 1.5. `ui/VideoEmbed.astro` + `lib/video-embed.ts` — фасад видео

Назначение: YouTube / RuTube / VK Video с **нулём запросов** к хостингу до
клика: iframe рендерит `srcdoc` с превью и CSS-кнопкой play, ссылка ведёт
на embed с `autoplay=1`.

Пропы: `url` (как её видит человек: watch/shorts/youtu.be/rutube/vk),
`title` (обязателен — title iframe'а и alt превью), `poster` (для
RuTube/VK фактически обязателен — у них нет угадываемого превью), `ratio`
`16/9|9/16` (для shorts — 9/16 автоматически), `playLabel`.

```astro
<VideoEmbed url="https://youtu.be/dQw4w9WgXcQ" title="Обзор кухни «Верона»" />
<VideoEmbed url="https://rutube.ru/video/<id>/" title="…" poster={posterSrc} />
```

Нераспознанный URL: в dev — throw (видно сразу), в проде — фолбэк-ссылка
вместо блока. `parseVideoUrl()` валидирует id жёсткими регулярками, всё
внешнее экранируется `escapeHtml()` перед конкатенацией в `srcdoc`.

Аналитика: цель `video_play` (`GOALS.VIDEO_PLAY`). Клик по play живёт
внутри srcdoc-документа и до родителя не всплывает — поэтому ловится
capture-слушателем `load` на `document`: навигация iframe'а на хостинг
делает `contentDocument` cross-origin (`null`) — это и есть момент запуска.
Один слушатель под `window.__videoEmbedInit`, `astro:page-load` не нужен.

### 1.6. `ui/BeforeAfter.astro` — сравнение «до/после»

Пропы: `before`/`after` (`ImageSource`, как у `ContentImage`),
`beforeAlt`/`afterAlt` (обязательны), `beforeLabel/afterLabel`, `start`
(0–100, % видимой «до»), `ratio` (по умолчанию `4/3`), `ariaLabel`,
`widths`/`sizes`.

```astro
<BeforeAfter before={oldPhoto} after={newPhoto} beforeAlt="Кухня до ремонта" afterAlt="Кухня после ремонта" />
```

Механика: две картинки друг над другом, верхняя обрезана `clip-path` по
CSS-переменной `--ba-pos`; управление — прозрачный нативный
`<input type="range">` поверх всей области (мышь, тач, клавиатура — без
pointer-обработчиков). Без JS рукоятка стоит на `start`. Обе картинки
`loading="lazy"` (правило одного eager LCP).

SPA: `window.__beforeAfterInit` + привязка по готовности DOM и на
`astro:page-load`, идемпотентность — `data-ready`.

### 1.7. `ui/Tooltip.astro` — подсказка

Пропы: `text`, `placement` `top|bottom|left|right` (flip у края), `delay`
(мс, hover). Триггер — содержимое слота, должен быть фокусируемым;
`aria-describedby` вешается на первый элемент слота.

```astro
<Tooltip text="Цена без монтажа">
  <button type="button" class="…">?</button>
</Tooltip>
```

Показ: hover (с задержкой) и focus/клик (клик покрывает тач). Скрытие:
mouseleave (с grace-таймером — можно навести на сам бабл), blur, Escape,
scroll, тап вне. На время показа бабл **портализуется в `<body>`** и
позиционируется `computePosition()` из `lib/positioning.ts` (см. §2.3).

SPA: `window.__tooltipInit`, привязка по готовности DOM и на
`astro:page-load` (`data-tt-ready`), scroll/resize открытого бабла чистятся
`AbortController`'ом, `astro:before-swap` закрывает мгновенно.

### 1.8. `ui/Dropdown.astro` — кнопка с меню

Пропы: `label` — **видимый текст кнопки** (не aria-label, в отличие от
Carousel/Tabs), `items: {label, href?, goal?}[]` (без `href` — кнопка;
`goal` → `window.trackConversion(goal)` при клике), `class`.

```astro
<Dropdown label="Каталог" items={[
  { label: 'Диваны', href: '/catalog/sofas/' },
  { label: 'Заказать звонок', goal: 'cta_click' },
]} />
```

WAI-APG menu button: `aria-haspopup/expanded/controls`, `role=menu/
menuitem`, roving tabindex, стрелки по кругу, Home/End, Escape возвращает
фокус на кнопку, клик-вне и уход фокуса закрывают. Меню портализуется в
`<body>` на время показа (§2.3).

SPA: как у Tooltip (`window.__dropdownInit`, `data-dd-ready`,
`AbortController`, `astro:before-swap`).

### 1.9. `ui/Pagination.astro` + `lib/pagination.ts`

Пропы: `currentPage`, `totalPages`, `href: (n) => string` (единственный
источник адресов), `around` (соседей по сторонам, по умолчанию 2),
подписи `ariaLabel`, `firstPageLabel/previousPageLabel/nextPageLabel/
lastPageLabel`, `pageLabel` (`{n}`), `progressLabel` (`{current}`,
`{total}`).

```astro
<Pagination currentPage={page.currentPage} totalPages={page.lastPage} href={(n) => pageUrl(n, { base: '/blog/' })} />
```

Крайние кнопки, которым «некуда» — `<span class="disabled">`, не ссылка на
себя; текущая — `aria-current="page"`; разрыв ровно в одну страницу не
схлопывается в многоточие («1 2 3», а не «1 … 3»); при `totalPages <= 1`
не рендерится. Чистая математика (`visiblePages`, `paginationLinks`,
`pageUrl`, `formatPageLabel`) — в `lib/pagination.ts` с unit-тестом.

Блог уже на ней: `/blog/` — первая страница, `/blog/page/N/` — остальные
(`src/pages/blog/page/[page].astro`, `/blog/page/1/` отфильтрован, чтобы
не дублировать корень), размер — `BLOG_PAGE_SIZE` в `src/config/site.ts`
(кратно трём колонкам сетки), обе страницы рендерит один
`blog/BlogListing.astro` (страницы 2+ получают свой `title` и крошки).

## 2. Паттерны

### 2.1. Делегирование на `document` vs привязка на `astro:page-load`

Два способа быть SPA-safe, выбирать по тому, нужно ли состояние на узле:

| | Делегирование на `document` | Привязка к узлам на `astro:page-load` |
|---|---|---|
| Кто | Modal, Toast, VideoEmbed, Tabs (клики/клавиатура) | Carousel, BeforeAfter, Tooltip, Dropdown, Tabs (восстановление `syncKey`) |
| Как | один `document.addEventListener` под флагом `window.__xInit`; цель ищется от `event.target` через `closest()` | на каждый `page-load` — `querySelectorAll('[data-x]:not([data-x-ready])')`, пометка `data-x-ready` |
| Плюс | ничего не замыкает пер-страничные узлы; новые элементы из свапнутого body работают сами | можно держать инстанс (слушатели скролла, таймеры) и чистить его |
| Минус | не подходит, когда нужен `scroll`/`resize` на конкретном узле или ARIA-связка при старте | нужен cleanup отвалившихся инстансов (Carousel: `document.contains`) |

Оба варианта: ранний старт по `DOMContentLoaded` (если `readyState ===
'loading'`) **плюс** `astro:page-load`. На первичной загрузке `page-load`
приходит только по `window.load` — ждать его значит отдать посетителю
мёртвый слайдер на медленной сети; `data-*-ready` делает повтор безопасным.

События, которые **не всплывают** (`close` у `<dialog>`, `load` у iframe),
делегируются capture-фазой: `document.addEventListener('close', fn, true)`.

### 2.2. Флаги в `src/env.d.ts`

Бандл-скрипты проверяются TypeScript'ом (в отличие от `is:inline`), поэтому
каждому `window.__fooInit` нужно объявление. Все флаги живут в одном месте
— интерфейсе `Window` в `src/env.d.ts` (`__modalInit`, `__toastInit`,
`__carouselInit`, `__carouselStore`, `__tabsInit`, `__tooltipInit`,
`__dropdownInit`, `__beforeAfterInit`, `__videoEmbedInit`…), там же типы
публичных API (`ToastApi`, `CarouselInstance`). Новый компонент с флагом —
новая строка там, а не `declare global` в каждом файле: повторные
объявления одного свойства обязаны совпадать типом, и разбросанные
объявления рано или поздно расходятся (`ym`/`__ymId` по этой причине
объявлены только в `lib/analytics.ts`).

### 2.3. Портал в `<body>` с плейсхолдером и `pendingFinalize`

Tooltip и Dropdown позиционируются `position: fixed` координатами от
`computePosition()` (`lib/positioning.ts`: flip на противоположную сторону
у края вьюпорта + shift в пределы с отступом; поперечная ось центрируется;
чистая математика — `computePositionFromRects`, покрыта unit-тестом). Fixed
честен только у прямого потомка `<body>`: **любой `transform` на предке
делает fixed локальным** — в том числе отработавший `data-reveal` из
`global.css`, который оставляет `translateY(0)`. CSS Anchor Positioning не
используется (Chromium-only).

Поэтому на время показа плавающий элемент переносится в `<body>`:

```ts
const placeholder = document.createComment('tt-placeholder');
bubble.before(placeholder);          // запомнить место в DOM
document.body.appendChild(bubble);   // показать
// … при закрытии:
placeholder.parentNode?.insertBefore(bubble, placeholder);
placeholder.remove();
```

Возврат на место (`finalize`) отложен на длительность exit-анимации.
Гонка: пока идёт анимация закрытия, `current === null`, а элемент ещё в
`<body>`; если в этот момент открывается **другой** экземпляр и его
`showNow` делает голый `clearTimeout(animTimer)`, отложенный `finalize`
никогда не выполнится — бабл остаётся в `<body>` навсегда (невидимый слой
над контентом, под reduce — видимый «призрак»). Канон:

```ts
let pendingFinalize: (() => void) | null = null;

function flushPending() {          // добить незавершённое закрытие синхронно
  clearTimeout(animTimer);
  const fin = pendingFinalize;
  pendingFinalize = null;
  fin?.();
}
// closeNow(): flushPending(); pendingFinalize = finalize; animTimer = setTimeout(() => { pendingFinalize = null; finalize(); }, ANIM_MS);
// showNow():  flushPending(); …портализовать новый…
```

Под `prefers-reduced-motion: reduce` — `finalize()` сразу, без таймера
(`transitionend` на статичном элементе не придёт). `astro:before-swap` —
закрытие с `immediate: true`.

### 2.4. Скролл-лок

Сейчас в стартере **три независимых писателя** `document.body.style.overflow`:
`Modal` (по факту наличия `dialog[open]` — «счётчик» открытых диалогов),
`Lightbox` и `LeadPopup` (ставят/снимают напрямую). Пока они не
открываются одновременно, всё работает; закрытие одного поверх другого
снимет лок обоим ([gotchas №37](gotchas.md)). Правила:

- новый оверлей со скролл-локом — **не четвёртый писатель**: при его
  появлении выносить общий счётчик в `src/lib/scroll-lock.ts`
  (`lock()`/`unlock()` с подсчётом, снятие при нуле) и перевести на него
  все четыре;
- лок снимать на `astro:before-swap` — иначе он утекает на следующую
  страницу (gotchas №5);
- `overflow: hidden` на body, не `position: fixed`: у второго — прыжок
  и smooth-scroll при разлоке (gotchas №8).

### 2.5. Boot-тесты под jsdom

Скрипт компонента вырезается из `.astro` регуляркой, типы снимаются
`ts.transpileModule` (**не esbuild** — под `@vitest-environment jsdom` он
падает на realm-инварианте `TextEncoder().encode() instanceof Uint8Array`),
`import.meta.env.DEV` подменяется литералом (внутри `new Function`
`import.meta` — синтаксическая ошибка), путь к файлу — `join(process.cwd(),
…)`, а не `new URL(…, import.meta.url)` (под jsdom это не `file:`-URL).
Образец — `src/components/common/__tests__/modal-boot.test.ts`; подробнее
[gotchas №38](gotchas.md).

## 3. Источники и атрибуция

Компоненты написаны заново под конвенции стартера (токены, `ContentImage`,
`GOALS`, `env.d.ts`, SPA-канон), но паттерны адаптированы из открытых
Astro-проектов — их клоны для ресерча лежат в `.research/` (в
`.gitignore`, в репозиторий не входят):

| Проект | Лицензия | Что взято |
|---|---|---|
| accessible-astro-components (Incluud) | MIT | Toast (role=log, sr-only префиксы), Tabs (ARIA-связки, roving tabindex), Pagination (`<span class="disabled">` вместо ссылок на себя) |
| Starwind UI (Boston343; legacy-исходники demo) | MIT | Tooltip, Dropdown, `positioning.ts` (flip/shift, упрощён с 12 кандидатов до 4 сторон), идея `syncKey` у Tabs |
| Fulldev UI (Sil Veltman) | MIT | жизненный цикл Carousel (вместо Embla — нативный scroll-snap), фасад видео (`iframe` + `srcdoc`) |
| AstroWind, ScrewFast, Foxi, PowerAI | MIT | идеи раскладок секций (team/stats/logos/timeline, варианты hero) — без переноса кода |
| Astroship | GPL | только просмотр — **код не копировался** (лицензия несовместима с закрытым шаблоном) |
| Play Astro | без лицензии | только просмотр — **код не копировался** |

При переносе новых паттернов: MIT/ISC/BSD — адаптировать с упоминанием
здесь; GPL/AGPL и «без лицензии» — смотреть, как устроено, и писать своё.
