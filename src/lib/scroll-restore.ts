/**
 * ============================================================================
 *  scroll-restore.ts — восстановление позиции прокрутки ПО ОРИЕНТИРУ.
 * ----------------------------------------------------------------------------
 *  ЗАЧЕМ. Обычное восстановление сохраняет `history.state.scrollY` — абсолютное
 *  число пикселей. Это надёжно только если высота документа одинакова в момент
 *  сохранения и в момент восстановления. На живой странице это не так:
 *
 *   • ленивый пин (GSAP ScrollTrigger и подобные сцены) добавляет распорку в
 *     сотни-тысячи px, но строится ПОСЛЕ `load` и приближения секции к экрану —
 *     сразу после свопа/перезагрузки её ещё нет;
 *   • `content-visibility: auto` держит непрорисованные секции на оценочной
 *     высоте (`contain-intrinsic-size`) — ещё десятки-сотни px расхождения;
 *   • поздно доехавшие картинки и шрифты двигают своим layout shift всё, что
 *     ниже них.
 *
 *  Итог: сохранённый пиксель указывает уже на другой контент, а если он больше
 *  максимума укоротившегося документа — браузер зажимает его в конец, и человек
 *  оказывается в футере. Симптомы, замеры и полный разбор —
 *  docs/recipes/scroll-pitfalls.md §1–§3.
 *
 *  РЕШЕНИЕ. Запоминаем не пиксель, а «на какой секции стоял верх экрана и
 *  насколько глубоко в неё вошли». При восстановлении координата считается
 *  заново по фактической раскладке, поэтому любое изменение высоты ВЫШЕ этой
 *  секции больше не сдвигает человека по контенту. Сырой пиксель хранится
 *  рядом как запасной вариант — на случай, если секция исчезла из разметки.
 *
 *  Дальше позиция ещё и ДОДЕРЖИВАЕТСЯ: пока раскладка оседает (по умолчанию до
 *  2.5с), цель пересчитывается на каждом изменении высоты документа. Как только
 *  человек сам коснулся страницы (колесо/тач/клавиши) — правки прекращаются,
 *  прокрутка принадлежит ему.
 *
 *  Чистые функции ниже (`pickAnchor`/`anchorTarget`) не знают про DOM —
 *  геометрию им приносит `initScrollRestore()`. Так их можно проверить без
 *  движка раскладки (jsdom отдаёт нули из getBoundingClientRect):
 *  src/lib/__tests__/scroll-restore.test.ts.
 * ============================================================================
 */

/** Ориентир раскладки: секция страницы с её положением в документе. */
export interface Landmark {
  /** Стабильный ключ, переживающий пересоздание DOM (`#id` или `tag>N`). */
  key: string;
  /** Смещение верха от начала документа, px. */
  top: number;
  /** Высота, px. */
  height: number;
}

/** Запомненная позиция: секция + глубина входа в неё (+ сырой пиксель). */
export interface ScrollAnchor {
  key: string;
  /** Сколько px от верха секции до верха экрана. Может быть отрицательным,
   *  если экран стоит ВЫШЕ первой секции (хедер, начало первого блока). */
  within: number;
  /** `scrollY` на момент сохранения — запасной вариант. */
  y: number;
}

/**
 * Ориентир, на котором стоит верх экрана: последний, чей верх не ниже
 * `scrollY`. Список должен быть отсортирован по `top` (DOM-порядок это и
 * даёт). Выше первого ориентира — он же с отрицательной глубиной.
 */
export function pickAnchor(marks: Landmark[], scrollY: number): ScrollAnchor | null {
  if (!marks.length) return null;
  let chosen = marks[0]!;
  for (const mark of marks) {
    if (mark.top <= scrollY) chosen = mark;
    else break;
  }
  return {
    key: chosen.key,
    within: Math.round(scrollY - chosen.top),
    y: Math.round(scrollY),
  };
}

/**
 * Координата, на которую надо встать сейчас, чтобы под верхом экрана был тот
 * же контент. Секции нет в текущей раскладке — откат на сырой пиксель.
 */
export function anchorTarget(
  anchor: ScrollAnchor,
  marks: Landmark[],
  maxScroll: number,
): number {
  const mark = marks.find((m) => m.key === anchor.key);
  const raw = mark ? mark.top + anchor.within : anchor.y;
  return Math.max(0, Math.min(Math.max(0, maxScroll), Math.round(raw)));
}

/* ==========================================================================
   DOM-обвязка
   ========================================================================== */

/** Ключ в `history.state`. Роутер Astro сохраняет чужие поля состояния
 *  (`updateScrollPosition` делает `{...history.state, ...positions}`), так что
 *  ориентир переживает и его записи скролла, и переходы «назад/вперёд». */
const STATE_KEY = '__scrollAnchor';

/** Настройки под конкретный сайт — см. `initScrollRestore`. */
export interface ScrollRestoreOptions {
  /** Что считать секцией-ориентиром. */
  landmarkSelector?: string;
  /** Сколько ждём, пока раскладка осядет (пин, картинки, шрифты). */
  settleMs?: number;
}

const DEFAULT_LANDMARK_SELECTOR = 'main > *, footer';
const DEFAULT_SETTLE_MS = 2500;

/** Живые настройки: `initScrollRestore` зовут на каждом `astro:page-load`,
 *  и додержание (оно переживает вызов) должно читать актуальные значения. */
let landmarkSelector = DEFAULT_LANDMARK_SELECTOR;
let settleMs = DEFAULT_SETTLE_MS;

/**
 * Секции-ориентиры в порядке документа. Ключ — `id`, если он есть; иначе
 * порядковый номер, он стабилен, потому что разметка страницы не меняется
 * между её же загрузками.
 */
function landmarks(): Landmark[] {
  const nodes = Array.from(document.querySelectorAll(landmarkSelector));
  const marks: Landmark[] = [];
  const pageY = window.scrollY;
  nodes.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    // Схлопнутые/невидимые узлы (скрытые баннеры, пустые обёртки) ориентирами
    // быть не могут: их «верх» ничего не значит.
    if (rect.height < 1) return;
    marks.push({
      key: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}>${i}`,
      top: rect.top + pageY,
      height: rect.height,
    });
  });
  return marks;
}

function maxScroll(): number {
  return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
}

/**
 * Пока идёт переход, писать в `history.state` НЕЛЬЗЯ.
 *
 * При переходе «назад» браузер уже подменил состояние на состояние ЦЕЛЕВОЙ
 * записи, а роутер Astro в этот момент двигает страницу (сначала в ноль, потом
 * к сохранённой позиции). Прилетающий на этом движении `scrollend` записал бы
 * промежуточную позицию поверх сохранённой — содержательный ориентир
 * затирается позицией у самого верха страницы, и восстанавливать становится
 * нечего. Роутер Astro обходит это тем же приёмом: при
 * `navigationType === 'traverse'` он свои scrollX/scrollY не пишет.
 * Подробнее — docs/recipes/scroll-pitfalls.md §2.
 */
let suspended = false;

/** Записать текущую позицию в состояние истории (рядом с полями Astro). */
/**
 * Программная прокрутка ведёт страницу прямо сейчас (`src/lib/scroll-to.ts`).
 *
 * Её доводящий цикл двигает позицию каждый кадр, пока раскладка оседает, и
 * каждое такое движение промежуточное. Запомнить любое из них значило бы
 * сохранить позицию, на которой человек не останавливался: следующий возврат
 * «назад» привёл бы его в случайную точку посередине проезда.
 * См. docs/recipes/scroll-pitfalls.md §9.
 */
function scrollToActive(): boolean {
  return (window as typeof window & { __scrollToActive?: boolean }).__scrollToActive === true;
}

function saveAnchor(): void {
  if (suspended || scrollToActive()) return;
  if (!history.state) return; // до первого replaceState роутера — нечего дополнять
  const anchor = pickAnchor(landmarks(), window.scrollY);
  if (!anchor) return;
  try {
    history.replaceState({ ...history.state, [STATE_KEY]: anchor }, '');
  } catch {
    /* приватный режим / переполнение состояния — просто без ориентира */
  }
}

let settleRaf = 0;

function stopSettling(): void {
  if (settleRaf) cancelAnimationFrame(settleRaf);
  settleRaf = 0;
  // Страница осела (или человек взял прокрутку на себя) — снова запоминаем.
  suspended = false;
}

/**
 * Прокрутка принадлежит человеку с первого его касания. Слушатели постоянные
 * (вешаются один раз на вкладку), а флаг сбрасывается в начале КАЖДОЙ
 * навигации: иначе колесо, провёрнутое пока страница ещё грузилась, не
 * успевало бы зарегистрироваться — слушатели вешались только к моменту
 * восстановления, то есть уже после этого движения.
 */
let userTookOver = false;

function markUserTookOver(): void {
  userTookOver = true;
  stopSettling();
}

/**
 * Восстановление + додержание, пока раскладка оседает. `behavior: 'instant'`
 * обязателен: в global.css стоит `html { scroll-behavior: smooth }`, и обычный
 * `scrollTo(0, y)` был бы анимированным — его обрывает любой чужой скролл
 * (например, `ScrollTrigger.refresh()`), и человек застревает на полпути
 * (docs/recipes/scroll-pitfalls.md §3).
 */
function restoreAnchor(anchor: ScrollAnchor): void {
  stopSettling();

  let lastApplied = -1;
  const apply = (): void => {
    const target = anchorTarget(anchor, landmarks(), maxScroll());
    if (Math.abs(window.scrollY - target) > 1) {
      window.scrollTo({ left: 0, top: target, behavior: 'instant' as ScrollBehavior });
    }
    lastApplied = target;
  };

  if (userTookOver) {
    suspended = false;
    return;
  }
  apply();

  // Пин-распорка появляется через несколько кадров после `load`, картинки и
  // шрифты — тоже не мгновенно. Пока высота документа меняется, цель
  // пересчитывается: контент под верхом экрана остаётся тем же.
  let lastHeight = document.documentElement.scrollHeight;
  const deadline = Date.now() + settleMs;
  const tick = (): void => {
    if (userTookOver || Date.now() > deadline) {
      stopSettling();
      return;
    }
    const height = document.documentElement.scrollHeight;
    // Страница стоит на месте, а позиция уехала — значит её увёл не мы:
    // человек тронул экран, либо чужой скрипт (`ScrollTrigger.refresh()`,
    // фокус в поле). Второй рубеж на случай, если событие ввода не пришло:
    // на мобильных инерционная прокрутка идёт без новых `touchstart`.
    if (height === lastHeight && Math.abs(window.scrollY - lastApplied) > 4) {
      stopSettling();
      return;
    }
    if (height !== lastHeight) {
      lastHeight = height;
      apply();
    }
    settleRaf = requestAnimationFrame(tick);
  };
  settleRaf = requestAnimationFrame(tick);
}

/**
 * Включает систему. Идемпотентна — вешает слушатели один раз на вкладку
 * (`document` переживает SPA-свопы), поэтому её можно звать на каждом
 * `astro:page-load`.
 *
 * @param options.landmarkSelector что считать секцией-ориентиром. По умолчанию
 *   прямые дети `<main>` и футер. Меняйте, если секции лежат глубже (обёртка
 *   внутри `main`) — ориентиром должен быть блок ВЫСОТОЙ с экран и больше,
 *   иначе глубина входа теряет смысл.
 * @param options.settleMs сколько додерживать позицию после восстановления.
 */
export function initScrollRestore(options: ScrollRestoreOptions = {}): void {
  landmarkSelector = options.landmarkSelector ?? DEFAULT_LANDMARK_SELECTOR;
  settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

  const w = window as typeof window & { __scrollRestoreBound?: boolean };

  if (!w.__scrollRestoreBound) {
    w.__scrollRestoreBound = true;

    // ── Сохранение ──────────────────────────────────────────────────────
    // `scrollend` — там же, где роутер Astro пишет свои scrollX/scrollY.
    // Через переменную, а не `if ('onscrollend' in window)`: сужение типа
    // делает `window` в ветке `else` типом `never` (astro check ругается).
    const hasScrollEnd = typeof window.onscrollend !== 'undefined';
    if (hasScrollEnd) {
      window.addEventListener('scrollend', saveAnchor, { passive: true });
    } else {
      // Safari <17: дожидаемся паузы в прокрутке сами.
      let idle = 0;
      window.addEventListener(
        'scroll',
        () => {
          clearTimeout(idle);
          idle = window.setTimeout(saveAnchor, 120);
        },
        { passive: true },
      );
    }
    // Уход со страницы: SPA-переход и обычная выгрузка (перезагрузка, закрытие,
    // сворачивание вкладки на мобильном — там `pagehide` может не прийти).
    window.addEventListener('pagehide', saveAnchor);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveAnchor();
    });

    // Человек взял прокрутку на себя — постоянные слушатели, см. userTookOver.
    ['wheel', 'touchstart', 'keydown'].forEach((type) => {
      window.addEventListener(type, markUserTookOver, { passive: true });
    });

    // `popstate` прилетает ДО того, как роутер начнёт свой переход, а состояние
    // в этот момент уже принадлежит целевой записи — замираем сразу.
    window.addEventListener('popstate', () => {
      suspended = true;
      userTookOver = false;
    });

    document.addEventListener('astro:before-preparation', (event) => {
      const nav = (event as Event & { navigationType?: string }).navigationType;
      // Обычный переход по ссылке: дописываем свежую позицию в запись, которую
      // покидаем (последний `scrollend` мог не успеть). При `traverse` —
      // наоборот, молчим: состояние уже целевое.
      if (nav !== 'traverse') saveAnchor();
      suspended = true;
      userTookOver = false; // отсчёт «человек вмешался» — с начала перехода
    });
  }

  // ── Восстановление ──────────────────────────────────────────────────
  // С якорем в адресе цель задаёт он (браузер/роутер/скрипт секции), не мы.
  if (location.hash.length > 1) {
    suspended = false;
    return;
  }

  const state = history.state as (Record<string, unknown> & { scrollY?: number }) | null;
  if (!state) {
    suspended = false;
    return;
  }
  // Читаем СИНХРОННО, до первого кадра: дальше состояние может быть переписано.
  const anchor = state[STATE_KEY] as ScrollAnchor | undefined;

  if (anchor && typeof anchor.within === 'number') {
    // Два кадра: первый отдаёт текущую отрисовку, второй — уже осевшую
    // раскладку. Дальше цель всё равно пересчитывается по высоте документа.
    requestAnimationFrame(() => requestAnimationFrame(() => restoreAnchor(anchor)));
    return;
  }

  // Состояние без ориентира (первый заход, ссылка извне, история от прошлой
  // версии сайта) — старое поведение по сырому пикселю, лучше чем ничего.
  const y = typeof state.scrollY === 'number' ? state.scrollY : 0;
  if (y > 0) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => restoreAnchor({ key: '', within: 0, y })),
    );
  } else {
    suspended = false; // переход вперёд: страница просто открывается сверху
  }
}
