/**
 * ============================================================================
 *  scroll-to.ts — устойчивый программный скролл к элементу.
 * ----------------------------------------------------------------------------
 *  Зачем отдельная утилита, если есть `scrollIntoView({ behavior: 'smooth' })`:
 *
 *  1. НАТИВНАЯ ПЛАВНАЯ ПРОКРУТКА ПРЕРЫВАЕТСЯ ЧУЖИМ `scrollTo`. При
 *     `html { scroll-behavior: smooth }` любой `scrollTo(0, y)` из кода тоже
 *     становится анимированным — и его обрывает первый же чужой вызов:
 *     `ScrollTrigger.refresh()` по событию `load`, восстановление позиции в
 *     BaseLayout, доехавшая картинка. Человек, нажавший CTA до полной загрузки
 *     страницы, застревал на середине пути. Из `global.css` эта строчка убрана
 *     26.08.2026, но `behavior: 'instant'` здесь всё равно ставится явно:
 *     правило могут вернуть, а плавность и без него даёт своя rAF-анимация —
 *     она пишет позицию каждый кадр, и одиночный чужой `scrollTo`
 *     перекрывается следующим.
 *     Подробности — docs/recipes/scroll-pitfalls.md §3.
 *
 *  2. ЦЕЛЬ УСТАРЕВАЕТ ПОКА ЛЕТИМ. Раскладка ВЫШЕ цели продолжает «доезжать»
 *     (ленивые картинки, `content-visibility`, шрифты, пин-распорка GSAP), и
 *     координата, снятая в начале анимации, к её концу указывает не туда.
 *     Здесь цель пересчитывается НА КАЖДОМ КАДРЕ — см. `scroll-pitfalls.md §1`,
 *     это та же болезнь, что у восстановления позиции по сырому пикселю.
 *
 *  3. ФИКСИРОВАННАЯ ОБВЯЗКА СЪЕДАЕТ ЭКРАН. Сверху — шапка `#site-header`,
 *     снизу — липкий остров `#mobile-cta` и/или cookie-полоса
 *     `#cookie-consent` (на десктопе островка нет, полоса есть; на мобиле с
 *     открытой полосой остров ещё и приподнят над ней). Нативный якорь знает
 *     только про `scroll-padding-top` и ставит ВЕРХ секции под шапку; карточка
 *     формы при этом оказывается наполовину под обвязкой. Режим `block: 'fit'`
 *     вписывает элемент ЦЕЛИКОМ в свободное окно между ними.
 *
 *  Чистая математика вынесена в `computeTargetY` и покрыта тестами
 *  (src/lib/__tests__/scroll-to.test.ts); DOM-обвязка вокруг неё — измерения
 *  и rAF, их проверяет только браузер.
 * ============================================================================
 */

/** Максимальный зазор сверху в режиме `fit`: на большом экране элемент не
 *  должен уплывать в середину — читается хуже, чем «чуть выше центра». */
const MAX_GAP = 80;

/** Отступ сверху, когда элемент в свободное окно не влезает (или `block:'start'`). */
const MIN_GAP = 12;

/** Зазор между элементом и краем фиксированной обвязки. */
const EDGE_GAP = 8;

export type ScrollBlock = 'fit' | 'start';

/**
 * Замеры, из которых считается целевая координата. Отдельный тип — чтобы
 * математику можно было проверить без браузера: DOM здесь не участвует.
 */
export interface TargetGeometry {
  /** Верх элемента в координатах ДОКУМЕНТА (scrollY + rect.top). */
  elementTop: number;
  elementHeight: number;
  viewportHeight: number;
  /** Сколько экрана съедено сверху (шапка + зазор). */
  topReserve: number;
  /** Сколько экрана съедено снизу (липкий остров + зазор). */
  bottomReserve: number;
  /** Предел прокрутки документа: `scrollHeight - viewportHeight`, не меньше 0. */
  maxScrollY: number;
  /** `'fit'` — вписать элемент целиком; `'start'` — прижать верх к шапке. */
  block?: ScrollBlock;
}

/**
 * Куда поставить страницу, чтобы элемент оказался в свободном окне.
 *
 * `fit`: если между шапкой и липким островом элемент помещается — половина
 * остатка уходит в зазор сверху (но не больше MAX_GAP, иначе на широком
 * мониторе карточка уезжает вниз и теряет связь с заголовком). Если не
 * помещается — прижимаем верх, потерять низ длинного элемента не страшно,
 * потерять начало — страшно.
 *
 * Результат зажат в [0, maxScrollY]: просить у браузера координату за концом
 * документа бессмысленно, а анимация, целящаяся туда, где страница уже
 * упёрлась, выглядит как зависание.
 */
export function computeTargetY(geometry: TargetGeometry): number {
  const {
    elementTop,
    elementHeight,
    viewportHeight,
    topReserve,
    bottomReserve,
    maxScrollY,
    block = 'fit',
  } = geometry;

  let gap = MIN_GAP;
  if (block === 'fit') {
    const free = viewportHeight - topReserve - bottomReserve - elementHeight;
    gap = free > 0 ? Math.min(free / 2, MAX_GAP) : MIN_GAP;
  }

  const y = Math.round(elementTop - topReserve - gap);
  return Math.min(Math.max(0, maxScrollY), Math.max(0, y));
}

/**
 * Длительность перелёта по его длине.
 *
 * Корень, а не пропорция: линейная зависимость на длинной странице даёт либо
 * бесконечное ползание, либо мгновенный рывок на коротких переходах. С корнем
 * ближний якорь проходится за 350мс, дальний (12 000px, ~13 экранов) — за
 * ~880мс, и оба ощущаются одним и тем же движением, только разной длины.
 *
 * Верхняя граница жёсткая: дольше секунды человек решает, что клик не
 * сработал, и жмёт ещё раз.
 */
export function scrollDuration(distance: number): number {
  return Math.min(900, Math.max(350, Math.round(Math.sqrt(Math.abs(distance)) * 8)));
}

/** easeInOutCubic. */
function ease(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

export interface ScrollToOptions {
  /** Плавно (rAF) или мгновенно. При `prefers-reduced-motion` всегда мгновенно. */
  animate?: boolean;
  /** См. `TargetGeometry.block`. */
  block?: ScrollBlock;
  /** Фиксированная шапка. Резервируется ВСЕГДА, даже если сейчас скрыта
   *  автоскрытием: она вернётся на скролле вверх и легла бы на верх элемента. */
  topReserveSelector?: string | null;
  /**
   * Фиксированная обвязка снизу. Селектор может перечислять НЕСКОЛЬКО узлов —
   * берётся максимум по видимым: на мобиле снизу висит остров `#mobile-cta`,
   * а поверх/под ним может стоять cookie-полоса `#cookie-consent`, и на
   * десктопе островка нет вовсе (`display: none` от `lg:hidden`), а полоса
   * есть. Учитывать только один из них — значит на половине экранов увести
   * кнопку формы под чужой фиксированный блок.
   */
  bottomReserveSelector?: string | null;
  /**
   * Класс «сейчас спрятан», который вешает на липкий остров его собственный
   * скрипт (`MobileStickyCTA.astro` → `.mcta-hidden`). Проверяется РАНЬШЕ
   * положения: спрятан остров трансформом, поэтому по координатам он
   * неотличим от «уехал вниз», а во время 0.3s перехода координаты вообще
   * промежуточные. Класс отвечает на вопрос сразу и точно.
   */
  bottomHiddenClass?: string | null;
  /**
   * Личный отступ элемента поверх шапки. По умолчанию берётся его
   * `scroll-margin-top`: браузер прибавляет это свойство к
   * `scroll-padding-top` контейнера, и программная прокрутка обязана делать
   * то же — иначе правила, настроенные под нативный якорь, начнут врать.
   *
   * Живой пример в стартере: заголовки правовых страниц (LegalLayout) стоят
   * на `scroll-margin-top: 96px` — там под якорем должно оставаться заметно
   * больше воздуха, чем под секцией главной.
   *
   * Явный `0` отключает учёт.
   */
  extraTopReserve?: number;
}

/**
 * Резерв сверху. Берём фактическую высоту шапки, а не CSS-переменную:
 * `scroll-padding-top` в global.css читает `--hdr-h` (Header.astro), но та
 * синхронизируется только на загрузке/resize — а шапка ещё и сжимается
 * при самом скролле (py-4 → py-2), так что переменная в моменте скролла
 * может быть чуть больше реальной высоты. Меряем DOM напрямую, чтобы не
 * зависеть от того, когда её в последний раз обновили.
 */
function measureTopReserve(selector: string | null | undefined): number {
  if (!selector) return 0;
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return 0;
  const height = el.getBoundingClientRect().height;
  // Схлопнутая шапка резерва не требует. Без этой проверки страница, где
  // `#site-header` в разметке есть, но скрыт (`display: none` на печати, у
  // отдельного лендинга, под `prefers-reduced-*`), получала бы фантомный
  // резерв в EDGE_GAP пикселей. Нижняя обвязка такие узлы пропускает давно —
  // асимметрия была недосмотром, а не решением.
  if (height < 1) return 0;
  return height + EDGE_GAP;
}

/**
 * Резерв снизу — максимум по всем видимым узлам селектора.
 *
 * Порядок проверок важен:
 *  1. `display: none` / нулевая высота — узла на экране нет (десктопный
 *     `#mobile-cta` под `lg:hidden`, свёрнутая cookie-полоса под
 *     Tailwind-классом `hidden`): не резервируем ничего.
 *  2. Числовой `bottom` из computed style — у `position: fixed` это ровно
 *     отступ от низа окна, и он УЖЕ учитывает
 *     `body.cookie-open .mobile-cta { bottom: var(--cookie-h) }` — остров,
 *     приподнятый над cookie-полосой, съедает экрана больше, чем своя
 *     высота. Плюс значение не «плывёт» во время 0.3s перехода, в отличие от
 *     координат. Если `bottom` задан числом — резервируем по нему и дальше
 *     не смотрим на `hiddenClass`.
 *  3. `hiddenClass` (`.mcta-hidden`) — только если `bottom` не число
 *     (`auto`): остров спрятан ТРАНСФОРМОМ, он измерим, стоит ниже экрана и
 *     вернётся, как только первый экран уйдёт вверх. Резервируем полную
 *     высоту.
 *  4. Иначе — позиционный расчёт от `rect.top` остаётся фолбэком.
 */
function measureBottomReserve(
  selector: string | null | undefined,
  viewportHeight: number,
  hiddenClass: string | null | undefined,
): number {
  if (!selector) return 0;
  let reserve = 0;
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) continue;

    const hidden = Boolean(hiddenClass && el.classList.contains(hiddenClass));
    const offset = Number.parseFloat(style.bottom);
    let value: number;
    if (Number.isFinite(offset)) {
      value = Math.max(0, offset) + rect.height + EDGE_GAP;
    } else if (hidden || rect.top >= viewportHeight) {
      value = rect.height + EDGE_GAP * 2;
    } else {
      value = Math.max(0, viewportHeight - rect.top) + EDGE_GAP;
    }
    reserve = Math.max(reserve, value);
  }
  return reserve;
}

/**
 * Предел прокрутки документа. Читается СВЕЖИМ на каждом кадре, без кеша, и
 * это принципиально.
 *
 * Кеш здесь был — на 8 кадров, ради экономии forced layout, — и стоил
 * дорого. Замер 28.08.2026 (кросс-страничный переход `/katalog/` →
 * `/#showroom`, 1440×900): страница вставала идеально, затем появлялся пин
 * конструктора и добавлял документу 3100px. Цикл честно пересчитывал цель по
 * новой геометрии — но зажимал её устаревшим пределом 12202 (`13102 − 900`,
 * высота ДО пина), попадал в него ровно, видел нулевой промах и объявлял
 * «приехали» в 28px от цели. Три кадра выдержки истекали задолго до восьми
 * кадров жизни кеша, так что до обновления дело не доходило никогда.
 *
 * Экономии, ради которой кеш заводился, на деле почти нет: `targetFor` строкой
 * выше уже вызвал `getBoundingClientRect()`, то есть раскладка на этом кадре
 * посчитана, и чтение `scrollHeight` следом второй раз её не считает.
 */
function maxScrollY(viewportHeight: number): number {
  return Math.max(0, document.documentElement.scrollHeight - viewportHeight);
}

/** `scroll-margin-top` элемента в пикселях. `auto` и мусор дают 0. */
function scrollMarginTop(el: HTMLElement): number {
  const raw = parseFloat(getComputedStyle(el).scrollMarginTop);
  return Number.isFinite(raw) ? raw : 0;
}

function targetFor(el: HTMLElement, opts: ScrollToOptions): number {
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight;
  return computeTargetY({
    elementTop: window.scrollY + rect.top,
    elementHeight: rect.height,
    viewportHeight: vh,
    topReserve:
      measureTopReserve(opts.topReserveSelector ?? '#site-header') +
      (opts.extraTopReserve ?? scrollMarginTop(el)),
    bottomReserve: measureBottomReserve(
      opts.bottomReserveSelector ?? '#mobile-cta, #cookie-consent',
      vh,
      opts.bottomHiddenClass === undefined ? 'mcta-hidden' : opts.bottomHiddenClass,
    ),
    maxScrollY: maxScrollY(vh),
    block: opts.block ?? 'fit',
  });
}

/** Мгновенная установка позиции: не полагаемся на отсутствие
 *  `scroll-behavior: smooth` в CSS — правило могут вернуть, и тогда каждый
 *  кадр цикла стал бы новой прерванной анимацией. */
function jump(y: number): void {
  window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior });
}

/* ==========================================================================
   Доводка до устойчивости
   ========================================================================== */

/** Допуск попадания, px. Меньше пикселя мерить нечем: `getBoundingClientRect`
 *  отдаёт дробные значения, а `scrollTo` округляет по-своему в каждом движке. */
export const TOLERANCE = 1;

/** Сколько кадров подряд надо простоять в допуске, чтобы признать приезд.
 *  Одного мало: раскладка часто «дышит» через кадр (доехавшая картинка,
 *  снятый `content-visibility`), и одиночное попадание ничего не значит. */
export const STEADY_FRAMES = 3;

/** Потолок активного цикла, мс. */
export const SETTLE_BUDGET_MS = 3000;

/**
 * Сколько ещё сторожим раскладку ПОСЛЕ приезда, мс.
 *
 * Прежняя версия ставила позицию трижды — сейчас, на следующем кадре и через
 * 250 мс. Это была ставка на то, что страница успеет достроиться за четверть
 * секунды. Замер 26.08.2026 (Chromium, дроссель 900 кбит/с, 390×844, холодный
 * заход по якорю) показал, чего это стоит: страница вставала к 6.6 с по
 * раскладке БЕЗ пина, чанк GSAP доезжал позже, пин добавлял 1903 px — и
 * человек оставался ровно на эту высоту выше цели.
 *
 * Увеличивать бюджет активного цикла — не выход: он крутит rAF каждый кадр, и
 * двадцать секунд такого цикла на каждом переходе никому не нужны.
 * `ResizeObserver` же не стоит ничего, пока высота документа не меняется, и
 * будит нас ровно на изменении — то есть тогда, когда цель действительно
 * уехала. Подробности — docs/recipes/scroll-pitfalls.md §9.
 */
export const WATCH_MS = 20000;

/**
 * Насколько позиция должна разойтись с оставленной, чтобы признать: страницу
 * ведёт человек. Доля экрана, но не меньше `FOREIGN_SCROLL_MIN_PX`.
 *
 * Порог не может быть маленьким, и это выяснилось замером 28.08.2026
 * (Chromium, дроссель, 390×844, холодный заход): через 50 мс после приезда
 * позиция сама сдвинулась на 22px при НЕИЗМЕННОЙ высоте документа — обычный
 * шум оседающей раскладки (докрутка браузерного scroll-anchoring, выехавший
 * липкий остров). Прежний порог в 4px принимал это за человека, выключал
 * сторожа, а через полторы секунды приходил пин конструктора (+1913px), и
 * исправлять было уже некому: страница оставалась ровно на высоту распорки
 * выше цели.
 *
 * Смысл порога — отличить ЧЕЛОВЕКА, а человека здесь видно только по
 * перетаскиванию полосы прокрутки: колесо, тач и клавиши мы слушаем напрямую,
 * и они обрывают доводку сами. Перетаскивание полосы — это всегда заметное
 * расстояние, а не десяток пикселей.
 */
export const FOREIGN_SCROLL_RATIO = 0.1;
export const FOREIGN_SCROLL_MIN_PX = 48;

/** Текущий порог «это не мы» в пикселях. */
export function foreignScrollThreshold(viewportHeight: number): number {
  return Math.max(FOREIGN_SCROLL_MIN_PX, Math.round(viewportHeight * FOREIGN_SCROLL_RATIO));
}

/** Что делать циклу на очередном кадре. */
export type SettleAction =
  /** Промах больше допуска — двигаем страницу. */
  | 'scroll'
  /** В допуске, но выдержки ещё не хватило — ждём следующий кадр. */
  | 'steady'
  /** Приехали, или вышел бюджет — активный цикл закончен. */
  | 'done';

/**
 * Решение цикла. Порядок проверок — это приоритет:
 *
 *  1. бюджет сильнее промаха: не приехали за `SETTLE_BUDGET_MS` — значит цель
 *     недостижима (зажата в конец документа, элемент уезжает быстрее, чем мы
 *     догоняем), и дальше это уже не доводка, а борьба со страницей;
 *  2. промах сбрасывает выдержку: попали, потом раскладка сдвинулась —
 *     считаем кадры заново, иначе засчитали бы случайное совпадение.
 *
 * Вмешательство человека здесь не проверяется: в этом модуле оно обрывает
 * прокрутку через `cancelScrollTo` и токен поколения (`generation`), а не
 * через возврат из этой функции.
 */
export function settleAction(miss: number, steady: number, elapsed: number): SettleAction {
  if (elapsed > SETTLE_BUDGET_MS) return 'done';
  if (Math.abs(miss) > TOLERANCE) return 'scroll';
  return steady + 1 >= STEADY_FRAMES ? 'done' : 'steady';
}

/* ==========================================================================
   Состояние прокрутки
   ========================================================================== */

let rafId = 0;
let listening = false;
let watcher: ResizeObserver | null = null;
let foreignScroll: (() => void) | null = null;
/** Отложенная на кадр проверка «прокрутку увёл не мы» — см. `watchLayout`. */
let foreignCheckRaf = 0;
/** Момент, после которого раскладку больше не сторожим. Ставится один раз на
 *  вызов `scrollToElement`, чтобы повторные доводки не продлевали окно вечно. */
let watchUntil = 0;

/**
 * Сколько раз за одну прокрутку мы уже возвращали страницу после чужого
 * НЕБОЛЬШОГО сноса. Счётчик общий на всё ведение (переармирование сторожа его
 * не сбрасывает) — иначе браузер и мы могли бы перетягивать страницу друг у
 * друга все двадцать секунд окна.
 */
let nudgeFixes = 0;
const MAX_NUDGE_FIXES = 4;


/**
 * Токен поколения. Растёт на каждой отмене и на каждом новом вызове; всякий
 * отложенный колбэк сверяется с ним и молча уходит, если поколение сменилось.
 *
 * Так надёжнее, чем гасить конкретные таймеры: колбэков теперь несколько
 * (кадр цикла, наблюдатель высоты, слушатель чужой прокрутки), и забыть
 * погасить один из них — вопрос времени.
 */
let generation = 0;

/**
 * Пока цикл ведёт страницу, `scroll-restore.ts` не вмешивается и не пишет
 * промежуточные позиции в историю: каждое наше движение промежуточное, и
 * запомнить любое из них значило бы сохранить позицию, на которой человек не
 * останавливался — следующий возврат «назад» привёл бы его в случайную точку
 * посередине проезда.
 *
 * Флаг снимается на приезде, ещё до того как включится сторож высоты: страница
 * уже на цели, позиция окончательная, и запоминать её можно.
 * См. docs/recipes/scroll-pitfalls.md §9.
 */
declare global {
  interface Window {
    __scrollToActive?: boolean;
  }
}

function setActive(active: boolean): void {
  window.__scrollToActive = active;
}

function stopWatch(): void {
  watcher?.disconnect();
  watcher = null;
  if (foreignScroll) window.removeEventListener('scroll', foreignScroll);
  foreignScroll = null;
  if (foreignCheckRaf) cancelAnimationFrame(foreignCheckRaf);
  foreignCheckRaf = 0;
}

/** Прокрутка с этого момента принадлежит человеку — свою прекращаем. */
export function cancelScrollTo(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  generation += 1;
  stopWatch();
  setActive(false);
}

/** Клавиши, которые действительно крутят страницу. Считать вмешательством
 *  любой `keydown` нельзя: переход по ссылке с клавиатуры — это Enter, и на
 *  удержании он сыплет repeat-события прямо в начатую этим же нажатием
 *  прокрутку. */
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

/** Слушатели вешаются один раз за вкладку и живут на `window` — они не держат
 *  ссылок на DOM конкретной страницы, поэтому SPA-свап им не страшен
 *  (docs/recipes/scroll-pitfalls.md §6). */
function ensureCancelListeners(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  for (const type of ['wheel', 'touchstart']) {
    window.addEventListener(type, cancelScrollTo, { passive: true });
  }
  window.addEventListener(
    'keydown',
    (ev) => {
      if (SCROLL_KEYS.has(ev.key)) cancelScrollTo();
    },
    { passive: true },
  );
}

/**
 * Сторожить раскладку после приезда: пин, картинки и шрифты меняют высоту
 * документа и вместе с ней позицию цели.
 *
 * Право вести теряем в трёх случаях:
 *
 *  • человек тронул колесо, тач или клавишу прокрутки (это гасит поколение
 *    через `cancelScrollTo`);
 *  • позиция уехала БЕЗ изменения высоты — так видно то, что не даёт событий
 *    ввода: перетаскивание полосы прокрутки, чужой `scrollTo`;
 *  • вышло окно `WATCH_MS`.
 *
 * Оговорка «без изменения высоты» — суть различения, а не мелочь. Создание
 * пина ScrollTrigger двигает позицию САМО: оно подправляет прокрутку, чтобы
 * визуально ничего не прыгнуло. Сторож, считающий любой сдвиг вмешательством
 * человека, выключается ровно в тот момент, ради которого написан. Различаем
 * так же, как `scroll-restore.ts`: изменилась высота — виновата раскладка,
 * ведём дальше; высота та же, а позиция уехала — ведёт человек.
 * Подробности — docs/recipes/scroll-pitfalls.md §10.
 */
function watchLayout(el: HTMLElement, opts: ScrollToOptions, gen: number): void {
  stopWatch();
  setActive(false); // приехали — позиция окончательная, restore вправе её запомнить
  if (typeof ResizeObserver === 'undefined') return;

  const topSelector = opts.topReserveSelector ?? '#site-header';
  const measure = (): { height: number; reserve: number } => ({
    height: document.documentElement.scrollHeight,
    reserve: measureTopReserve(topSelector),
  });

  let last = measure();
  const settledAt = window.scrollY;

  foreignScroll = (): void => {
    // Пока цикл доводит, прокрутку двигаем мы сами — судить тут нечего.
    if (window.__scrollToActive || foreignCheckRaf) return;
    foreignCheckRaf = requestAnimationFrame(() => {
      foreignCheckRaf = 0;
      if (window.__scrollToActive) return;
      if (document.documentElement.scrollHeight !== last.height) return; // поехала раскладка
      if (gen !== generation || performance.now() > watchUntil) return;

      const drift = Math.abs(window.scrollY - settledAt);
      if (drift <= TOLERANCE) return;

      if (drift > foreignScrollThreshold(window.innerHeight)) {
        cancelScrollTo(); // это человек тянет полосу прокрутки — прокрутка его
        return;
      }

      // Снос МЕНЬШЕ человеческого — значит страницу подтолкнул не человек:
      // scroll-anchoring браузера, доехавшая картинка, чужой одиночный
      // `scrollTo`. Такое надо не «замечать», а исправлять.
      //
      // Замер 28.08.2026 (WebKit, кросс-страничный переход `/katalog/` →
      // `/#showroom`): страница вставала ровно в цель, а через СЕКУНДУ после
      // приезда сама уезжала на 28px при неизменной высоте документа.
      // Наблюдатель за высотой такого не видит по определению, и человек
      // оставался в 28px от цели — стабильно, в каждом прогоне, только в этом
      // движке.
      //
      // Число подправок ограничено: если браузер упорно тянет страницу назад,
      // перетягивание канатом хуже, чем небольшой промах.
      if (nudgeFixes >= MAX_NUDGE_FIXES) return;
      nudgeFixes += 1;
      settleTo(el, opts, gen);
    });
  };
  window.addEventListener('scroll', foreignScroll, { passive: true });

  watcher = new ResizeObserver(() => {
    const now = measure();
    if (now.height === last.height && now.reserve === last.reserve) return;
    last = now;
    if (gen !== generation || performance.now() > watchUntil) {
      cancelScrollTo();
      return;
    }
    settleTo(el, opts, gen); // цель уехала — доводим заново
  });

  watcher.observe(document.documentElement);

  // Шапку сторожим ОТДЕЛЬНО, и это не перестраховка. Она сжимается на
  // прокрутке (Header.astro: py-4 → py-2 после 60px, ~16px разницы) — то есть
  // меняет нужный отступ, НЕ меняя высоту документа. Наблюдатель за одним
  // только корнем такое изменение проспал бы, и человек остался бы на высоту
  // сжатия ниже цели. Замер 26.08.2026: стенд показывал промах то +12px, то
  // +28px в одном и том же сценарии — разница ровно в сжатие шапки, а какая
  // из двух величин выпадет, решала гонка между сжатием и последним кадром
  // доводки.
  const header = document.querySelector<HTMLElement>(topSelector);
  if (header) watcher.observe(header);
}

/**
 * Активный цикл: вести страницу к цели, пока она не встанет и не постоит на
 * месте `STEADY_FRAMES` кадров подряд. Цель пересчитывается КАЖДЫЙ кадр —
 * раскладка выше неё продолжает доезжать (см. §2 в шапке файла).
 */
function settleTo(el: HTMLElement, opts: ScrollToOptions, gen: number): void {
  if (rafId) cancelAnimationFrame(rafId);
  stopWatch();
  setActive(true);

  const startedAt = performance.now();
  let steady = 0;

  const tick = (): void => {
    if (gen !== generation) return; // человек вмешался, или начали другую прокрутку
    const desired = targetFor(el, opts);
    const action = settleAction(desired - window.scrollY, steady, performance.now() - startedAt);

    if (action === 'done') {
      rafId = 0;
      watchLayout(el, opts, gen); // приехали — дальше только сторожим высоту
      return;
    }
    if (action === 'scroll') {
      steady = 0;
      jump(desired);
    } else {
      steady += 1;
    }
    rafId = requestAnimationFrame(tick);
  };

  tick();
}

function reduceMotion(): boolean {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Проскроллить страницу к элементу.
 *
 * `animate: false` — не просто «мгновенно», а МГНОВЕННО И НАДЁЖНО: одиночный
 * `scrollTo` в этот момент почти наверняка перебьёт кто-то ещё (роутер
 * дочиняет позицию, `ScrollTrigger.refresh()` снимает и возвращает скролл,
 * долетает `load`). Поэтому позиция не ставится один раз, а ДОВОДИТСЯ: цикл
 * держит цель, пока она не встанет и не постоит на месте, а потом за
 * раскладкой ещё присматривает `ResizeObserver` — пин, картинки и шрифты
 * умеют доезжать через много секунд после приезда.
 *
 * Обе ветки — и мгновенная, и плавная — заканчиваются одинаково: доводкой до
 * устойчивости и сторожем. Анимация решает только, КАК добираться; надёжность
 * попадания от этого выбора не зависит.
 */
export function scrollToElement(el: HTMLElement, opts: ScrollToOptions = {}): void {
  ensureCancelListeners();
  cancelScrollTo();

  const gen = generation;
  watchUntil = performance.now() + WATCH_MS;
  nudgeFixes = 0;
  setActive(true);
  const animate = (opts.animate ?? true) && !reduceMotion();

  if (!animate) {
    settleTo(el, opts, gen);
    return;
  }

  // Летим ОТ ТЕКУЩЕЙ точки и целиком, без единого телепорта.
  //
  // Раньше здесь стояла «перемотка»: путь длиннее трёх экранов начинался с
  // прыжка к точке за два экрана до цели, чтобы не пролетать сквозь десяток
  // тяжёлых секций. На странице в 15 экранов дальше трёх оказался КАЖДЫЙ пункт
  // меню — то есть прыжок был встроен в каждый клик (замер 28.08.2026:
  // 0 → 9159 браузером, 9159 → 7326 перемоткой, и только потом анимация).
  // Исходная причина к тому же почти отпала: `content-visibility` снимается в
  // `prepare()` ДО старта, так что пролёт больше не поднимает секции на ходу.
  const startY = window.scrollY;
  const duration = scrollDuration(targetFor(el, opts) - startY);
  const t0 = performance.now();

  const step = (now: number): void => {
    if (gen !== generation) return; // человек вмешался, или началась другая прокрутка
    const p = Math.min(1, (now - t0) / duration);
    // Цель СВЕЖАЯ на каждом кадре — раскладка выше могла доехать (см. §2 в
    // шапке файла), и высота документа тоже (см. `maxScrollY`).
    const target = targetFor(el, opts);
    jump(Math.round(startY + (target - startY) * ease(p)));
    if (p < 1) {
      rafId = requestAnimationFrame(step);
      return;
    }
    // Анимация доиграла — но это ещё не «приехали»: за время полёта раскладка
    // могла сдвинуться, а после него ещё сдвинется. Дальше та же доводка, что
    // и у мгновенной ветки.
    rafId = 0;
    settleTo(el, opts, gen);
  };
  rafId = requestAnimationFrame(step);
}
