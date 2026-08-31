#!/usr/bin/env node
/**
 * ============================================================================
 *  anchor-audit.mjs — стенд промахов якорной навигации.
 * ----------------------------------------------------------------------------
 *  ЗАЧЕМ.
 *
 *  Якорные ссылки приезжают в разные точки в зависимости от браузера и
 *  скорости сети: позиция секции зависит от того, доехала ли раскладка выше
 *  неё (ленивые картинки, `content-visibility`, шрифты, пин-распорка GSAP у
 *  ScrollScene/StackedShowcase), а доезжает она ПОЗЖЕ прыжка. Поймать это
 *  глазами нельзя — на быстрой машине и тёплом кэше всё выглядит целым.
 *  Нужен прибор, который меряет один и тот же промах одинаково в chromium,
 *  firefox и webkit, до правки и после.
 *
 *  Стенд НИЧЕГО НЕ ЧИНИТ. Он открывает живой сайт, воспроизводит шесть
 *  сценариев входа в якорь на двух вьюпортах и печатает таблицу промахов в
 *  пикселях. Критерий приёмки — |промах| ≤ 2 px в каждой клетке.
 *
 *  ПОЧЕМУ ЭТОТ СТЕНД САМ ИЩЕТ, ЧТО МЕРИТЬ.
 *  Прародитель стенда (боевой проект) был прибит гвоздями к одному сайту: якорь
 *  `#guarantees`, внутренняя страница `/katalog/`, ссылка `#showroom` в
 *  подвале, остров `.mcta`. Стартер разворачивается в произвольные сайты — у
 *  очередного клиента не будет ни одного из этих имён. Поэтому перед прогоном
 *  идёт РАЗВЕДКА (`discover`): стенд открывает главную и сам находит якорь,
 *  внутреннюю страницу и ссылку подвала — по структуре, а не по именам. Что
 *  именно выбрано, печатается в шапке отчёта, чтобы результат можно было
 *  перечитать через полгода и понять, что мерили.
 *
 *  Чего разведка не нашла — то помечается SKIP, а не роняет клетку в ERR.
 *  На одностраничнике без внутренних страниц сценарий `cross-page-hash`
 *  бессмысленен; отличать «нечего мерить» от «сломано» обязательно, иначе
 *  таблица врёт.
 *
 *  ПОЧЕМУ ПРОМАХ МЕРЯЕТСЯ ОТ ЭЛЕМЕНТА, А НЕ ОТ scrollY.
 *  scrollY бесполезен как мера: документ растёт под ногами, одно и то же
 *  число пикселей означает разные места контента до и после. Поэтому промах —
 *  это
 *      target.getBoundingClientRect().top - expectedOffset,
 *  то есть «насколько секция стоит не там, где должна» прямо сейчас, на
 *  фактической раскладке.
 *
 *  `expectedOffset` — живая высота `#site-header` + 8 + 12 +
 *  `scroll-margin-top` самой цели. Именно так считает отступ и рантайм
 *  стартера (`src/lib/scroll-to.ts`: `measureTopReserve` добавляет
 *  EDGE_GAP = 8, а `computeTargetY` в режиме `start` — ещё MIN_GAP = 12):
 *  шапка
 *  сжимается при прокрутке (py-4 → py-2) и прячется автоскрытием, поэтому
 *  константа из CSS (`scroll-padding-top: var(--hdr-h, 5rem)`) врала бы.
 *  `scroll-margin-top` учитываем отдельно: если секция просит у браузера
 *  дополнительный отступ, «правильное» место у неё другое, и без этого
 *  слагаемого стенд ругался бы на корректно приехавший якорь.
 *
 *  ПОЧЕМУ ПИШЕТСЯ ТРАЕКТОРИЯ, А НЕ ТОЛЬКО ИТОГ.
 *  Половина поломок даёт правильный итог с неправильным поведением: сначала
 *  человек остаётся на первом экране, а через секунду страницу «перелистывает»
 *  вниз. Итоговый промах при этом 0. Ловим это по числу отдельных движений
 *  (travelPhases): участков прокрутки, разделённых паузой ≥150 мс. Одно
 *  движение — норма; два и больше — «сначала одно, потом другое».
 *
 *  ДРОССЕЛЬ. Холодный заход воспроизводится только на медленной сети: на
 *  быстрой браузер не успевает уехать раньше загрузки. В chromium дросселируем
 *  через CDP (Network.emulateNetworkConditions + setCacheDisabled) — это
 *  настоящее ограничение полосы. В firefox/webkit протокола CDP нет, поэтому
 *  там задерживаем каждый ответ на 150 мс через context.route() и глушим кэш
 *  заголовками; полосы это не ограничивает, и в отчёте такая клетка помечена
 *  своим способом дросселирования — сравнивать абсолютные тайминги между
 *  движками нельзя, промах — можно.
 *
 *  Каждая клетка — свой контекст браузера: своя сессия, свой кэш, своя
 *  история. Состояние между сценариями не протекает, порядок прогона на
 *  результат не влияет.
 *
 *  Использование:
 *    node scripts/anchor-audit.mjs [--base http://localhost:4321]
 *                                  [--anchor id-секции]
 *                                  [--browsers chromium,firefox,webkit]
 *                                  [--viewports desktop,mobile]
 *                                  [--scenarios cold-hash,menu-click,...]
 *                                  [--json путь/к/дампу.json]
 *                                  [--no-fail-exit]
 *
 *  Код возврата: 0 — PASS, 1 — FAIL (--no-fail-exit оставляет 0 всегда, это
 *  нужно для снятия базовой линии «до правки», где всё заведомо красное).
 * ============================================================================
 */

import { writeFileSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';

/* ---------------------------------------------------------------- константы */

const ENGINES = { chromium, firefox, webkit };

const VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'mobile', width: 390, height: 844 },
];

const SCENARIOS = [
  'cold-hash',
  'menu-click',
  'footer-click',
  'reload',
  'logo-click',
  'cross-page-hash',
];

/**
 * Фиксированная обвязка стартера. Те же значения — умолчания
 * `scrollToElement()` в src/lib/scroll-to.ts; если сайт переименовал шапку или
 * липкий остров, правится в ОБОИХ местах, иначе рантайм и стенд считают
 * отступ по-разному и стенд начинает ругаться на исправный сайт.
 */
const TOP_CHROME = '#site-header';
const BOTTOM_CHROME = '#mobile-cta, #cookie-consent';

/** Мобильное меню стартера (Header.astro): бургер + раскрывающийся контейнер. */
const BURGER = '#burger';
const MOBILE_MENU = '#mobile-menu';

/** Зазор между краем шапки и верхом цели. Совпадает с EDGE_GAP в scroll-to.ts. */
const EDGE_GAP = 8;

/**
 * Зазор под шапкой в режиме `block: 'start'` — MIN_GAP из
 * `src/lib/scroll-to.ts`. Именно он отличает контракт стартера от «верх
 * секции вплотную под шапку»: под якорем остаётся немного воздуха.
 *
 * ВАЖНО: EDGE_GAP и MIN_GAP продублированы здесь из умолчаний
 * `scrollToElement()`. Разъедутся — и стенд начнёт ругаться на исправный
 * сайт, причём ровно на эту разницу и во всех клетках сразу. Так это и
 * поймали 26.08.2026: стенд, принесённый с боевого проекта (там отступ = шапка +
 * 8), показывал ровные +12 px по всей матрице — это и был здешний MIN_GAP.
 */
const MIN_GAP = 12;

/** Пауза, начиная с которой два движения считаются РАЗНЫМИ движениями. */
const PHASE_GAP_MS = 150;

/** Критерий приёмки. */
const PASS_PX = 2;

/** Точка, которой щупаем «что сейчас под верхом экрана» (сценарий reload). */
const PROBE_Y = 100;

/** Таймауты щедрые: под дросселем главная грузится десятки секунд. */
const NAV_TIMEOUT_MS = 180_000;
const ACT_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * «Мерить нечего» — не ошибка. Отдельный класс, чтобы `runCell` мог отличить
 * осознанный пропуск от падения: SKIP не идёт в список провалов и не
 * учитывается в знаменателе вердикта.
 */
class SkipScenario extends Error {}
const skip = (reason) => {
  throw new SkipScenario(reason);
};

/* ------------------------------------------------------------------ разбор */

function parseArgs(argv) {
  const args = {
    base: 'http://localhost:4321',
    anchor: null,
    browsers: Object.keys(ENGINES),
    viewports: VIEWPORTS.map((v) => v.id),
    scenarios: [...SCENARIOS],
    json: null,
    failExit: true,
  };
  const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--base') args.base = next();
    else if (arg === '--anchor') args.anchor = next().replace(/^#/, '');
    else if (arg === '--browsers') args.browsers = list(next());
    else if (arg === '--viewports') args.viewports = list(next());
    else if (arg === '--scenarios') args.scenarios = list(next());
    else if (arg === '--json') args.json = next();
    else if (arg === '--no-fail-exit') args.failExit = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`неизвестный аргумент: ${arg}`);
  }
  args.base = args.base.replace(/\/+$/, '');
  for (const id of args.browsers) if (!ENGINES[id]) throw new Error(`неизвестный браузер: ${id}`);
  for (const id of args.viewports) if (!VIEWPORTS.some((v) => v.id === id)) throw new Error(`неизвестный вьюпорт: ${id}`);
  for (const id of args.scenarios) if (!SCENARIOS.includes(id)) throw new Error(`неизвестный сценарий: ${id}`);
  return args;
}

/* ------------------------------------------------------- запись траектории */

/**
 * Ставится на каждый документ ДО его скриптов. Пишет scrollY по кадрам —
 * только моменты изменения, чтобы массив не рос в паузах. `__aaTrackReset()`
 * переносит начало отсчёта: им отделяем «подготовку клетки» (прокрутка к
 * ссылке, открытие бургера) от собственно измеряемого движения.
 */
function trackInit() {
  const track = { t0: performance.now(), samples: [] };
  let last = Number.NaN;
  const push = () => {
    const y = Math.round(window.scrollY);
    if (y !== last) {
      last = y;
      track.samples.push({ t: Math.round(performance.now()), y });
    }
  };
  window.__aaTrack = track;
  window.__aaTrackReset = () => {
    track.t0 = performance.now();
    last = Number.NaN;
    track.samples = [];
    push();
  };
  const tick = () => {
    push();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Из сырых отсчётов — две цифры: когда позиция окончательно замерла и сколько
 * было отдельных движений. Первый отсчёт — это базовая позиция, а не движение,
 * поэтому в счёт не идёт.
 */
function analyzeTrack(track) {
  if (!track || !Array.isArray(track.samples) || track.samples.length === 0) {
    return { settleMs: null, travelPhases: 0, moves: 0 };
  }
  const points = track.samples.filter((s) => s.t >= track.t0 - 1);
  const changes = points.slice(1);
  if (changes.length === 0) return { settleMs: 0, travelPhases: 0, moves: 0 };
  let phases = 1;
  for (let i = 1; i < changes.length; i += 1) {
    if (changes[i].t - changes[i - 1].t >= PHASE_GAP_MS) phases += 1;
  }
  return {
    settleMs: Math.round(changes[changes.length - 1].t - track.t0),
    travelPhases: phases,
    moves: changes.length,
  };
}

/* ---------------------------------------------------------------- разведка */

/**
 * Все якорные ссылки шапки вместе с положением их целей в документе.
 *
 * Мобильное меню стартера лежит ВНУТРИ `#site-header` (Header.astro), но
 * закрывать глаза на случай «вынесли наружу» нельзя — стенд шаблонный, поэтому
 * контейнер меню опрашивается ещё и отдельно. Дубли снимаются по id цели.
 *
 * Берём только ссылки на ЭТУ же страницу: `#id` и `/#id`. `/katalog/#id` —
 * это другой документ, там своя раскладка и своя история промахов; мешать их
 * в одну колонку нельзя.
 */
async function collectHeaderAnchors(page) {
  return page.evaluate(([headerSel, menuSel]) => {
    const roots = [document.querySelector(headerSel), document.querySelector(menuSel)].filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const root of roots) {
      for (const a of root.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const hash = href.startsWith('#') ? href.slice(1) : href.startsWith('/#') ? href.slice(2) : null;
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        const el = document.getElementById(hash);
        // Якоря со СВОЕЙ геометрией сайт объявляет сам, через
        // `registerAnchorTarget` (список виден в `__anchorNavCustom`). Мерить
        // их общей меркой «верх секции под шапку» нельзя: у режима `fit` цель
        // — поставить элемент в свободное окно целиком, это другая позиция.
        const custom = Array.isArray(window.__anchorNavCustom)
          ? window.__anchorNavCustom.includes(hash)
          : false;
        out.push({
          id: hash,
          href,
          custom,
          // Верх цели в координатах ДОКУМЕНТА: только так «глубина» не зависит
          // от того, где сейчас стоит страница.
          top: el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null,
        });
      }
    }
    return out;
  }, [TOP_CHROME, MOBILE_MENU]);
}

/**
 * Первая ссылка шапки на ВНУТРЕННЮЮ страницу этого же сайта — цель для
 * `cross-page-hash` (уход на другую страницу и возврат на главную по якорю).
 * Условия: свой origin, путь не `/`, без хеша (иначе это не «уйти со
 * страницы», а «прыгнуть внутри неё»), не `tel:`/`mailto:`.
 */
async function findInnerPage(page) {
  return page.evaluate((headerSel) => {
    const root = document.querySelector(headerSel);
    if (!root) return null;
    for (const a of root.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href') || '';
      if (/^(tel:|mailto:|javascript:)/i.test(raw)) continue;
      let url;
      try {
        url = new URL(a.href, location.href);
      } catch {
        continue;
      }
      if (url.origin !== location.origin) continue;
      if (url.hash) continue;
      if (url.pathname === '/' || url.pathname === '') continue;
      return { href: raw, path: url.pathname + url.search };
    }
    return null;
  }, TOP_CHROME);
}

/**
 * Первая якорная ссылка подвала, ведущая на ГЛАВНУЮ. `/katalog/#id` не
 * годится: клик по ней уводит на другую страницу, и мерили бы мы уже не
 * подвал главной, а кросс-страничный переход — это отдельный сценарий.
 */
async function findFooterAnchor(page) {
  return page.evaluate(() => {
    const foot = document.querySelector('footer');
    if (!foot) return null;
    for (const a of foot.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href') || '';
      const hash = raw.startsWith('#') ? raw.slice(1) : raw.startsWith('/#') ? raw.slice(2) : null;
      if (!hash) continue;
      return { href: raw, id: hash, exists: !!document.getElementById(hash) };
    }
    return null;
  });
}

/**
 * Логотип шапки. На боевом проекте он помечен классом `.brand`, у стартера — это
 * просто первая ссылка на `/` внутри `#site-header` (Header.astro:36).
 * Проверяем оба варианта и возвращаем готовый селектор, чтобы сценарий не
 * гадал в момент клика.
 */
async function findLogo(page) {
  return page.evaluate((headerSel) => {
    const root = document.querySelector(headerSel);
    if (!root) return null;
    if (root.querySelector('a.brand')) return { selector: `${headerSel} a.brand`, how: 'a.brand' };
    for (const a of root.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href') || '';
      if (raw === '/' || raw === '') {
        return { selector: `${headerSel} a[href="/"]`, how: 'первая ссылка на «/» в шапке' };
      }
    }
    return null;
  }, TOP_CHROME);
}

/**
 * Разведка: что именно мерить на этом сайте.
 *
 * Цель выбирается как САМЫЙ ГЛУБОКИЙ якорь из шапки — у него максимальный
 * `top` в координатах документа. Он строже всех проверяет накопленную ошибку
 * раскладки: до него лежит больше всего ленивых картинок, `content-visibility`
 * секций и пин-распорок, и любой недоезд раскладки выше по странице
 * складывается именно в его промахе. Якорь на первом экране такую ошибку
 * попросту не увидит.
 *
 * Разведка идёт ОДИН раз, на десктопном вьюпорте. Одна и та же цель во всех
 * клетках — условие сравнимости таблицы: если бы мобиль мерил другую секцию,
 * колонки «desktop» и «mobile» перестали бы быть двумя замерами одного и того
 * же и превратились бы в два независимых опыта.
 */
async function discover(browser, base, forcedAnchor) {
  const viewport = VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  });
  try {
    context.setDefaultTimeout(ACT_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    const page = await context.newPage();
    await page.goto(`${base}/`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    // Даём раскладке доехать: до этого момента «глубина» якорей — это глубина
    // недостроенной страницы, и самый нижний якорь может оказаться не тем.
    await sleep(2500);

    const anchors = await collectHeaderAnchors(page);
    const present = anchors.filter((a) => a.top !== null);

    let target = null;
    let how = '';
    if (forcedAnchor) {
      const exists = await page.evaluate((id) => !!document.getElementById(id), forcedAnchor);
      if (!exists) throw new Error(`--anchor ${forcedAnchor}: на главной нет элемента с таким id`);
      const known = present.find((a) => a.id === forcedAnchor);
      target = known || { id: forcedAnchor, href: `/#${forcedAnchor}`, top: null };
      how = 'задан флагом --anchor';
    } else if (present.length > 0) {
      // Нестандартные цели из автовыбора исключаем — см. `collectHeaderAnchors`.
      // Если их отсеять нечем (все якоря нестандартные), берём что есть и
      // честно предупреждаем: мерка будет чужая.
      const plain = present.filter((a) => !a.custom);
      const pool = plain.length > 0 ? plain : present;
      target = pool.reduce((deepest, a) => (a.top > deepest.top ? a : deepest));
      const skipped = present.length - plain.length;
      how =
        `автовыбор: самый глубокий из якорей шапки (кандидатов ${pool.length}, ` +
        `${target.top} px от верха документа)` +
        (skipped > 0 && plain.length > 0
          ? `; пропущено со своей геометрией: ${skipped}`
          : plain.length === 0
            ? '; ВНИМАНИЕ: все якоря со своей геометрией, мерка приблизительная'
            : '');
    }

    const inner = await findInnerPage(page);
    const footer = await findFooterAnchor(page);
    const logo = await findLogo(page);

    return {
      anchor: target,
      anchorHow: how,
      anchorCandidates: anchors,
      inner,
      footer,
      logo,
      docHeight: await page.evaluate(() => Math.round(document.documentElement.scrollHeight)),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/* ---------------------------------------------------------------- измерения */

/**
 * Промах якоря + всё окружение, объясняющее его происхождение.
 *
 * Ожидаемый отступ считается ЖИВЬЁМ и на каждом замере: высота шапки +
 * EDGE_GAP + MIN_GAP + `scroll-margin-top` цели. См. «почему» в шапке файла.
 */
async function measureAnchor(page, targetId) {
  const raw = await page.evaluate(([id, headerSel, bottomSel, gap, minGap]) => {
    const header = document.querySelector(headerSel);
    const headerH = header ? header.getBoundingClientRect().height : 0;
    const target = document.getElementById(id);
    const margin = target ? Number.parseFloat(getComputedStyle(target).scrollMarginTop) : 0;
    const expectedOffset = Math.round(headerH + gap + minGap + (Number.isFinite(margin) ? margin : 0));

    // Нижняя обвязка на промах не влияет (якорь целится под шапку), но
    // объясняет часть картинки в подробностях: остров и cookie-полоса съедают
    // экран и меняют то, что человек реально видит после прыжка.
    let bottomH = 0;
    for (const el of document.querySelectorAll(bottomSel)) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      bottomH = Math.max(bottomH, Math.round(el.getBoundingClientRect().height));
    }

    return {
      found: !!target,
      top: target ? Math.round(target.getBoundingClientRect().top) : null,
      expectedOffset,
      headerH: Math.round(headerH),
      scrollMarginTop: Math.round(Number.isFinite(margin) ? margin : 0),
      bottomChromeH: bottomH,
      scrollY: Math.round(window.scrollY),
      docHeight: Math.round(document.documentElement.scrollHeight),
      pinSpacer: !!document.querySelector('.pin-spacer'),
      cvOff: document.documentElement.classList.contains('cv-off'),
      track: window.__aaTrack ? { t0: window.__aaTrack.t0, samples: window.__aaTrack.samples.slice(-2000) } : null,
    };
  }, [targetId, TOP_CHROME, BOTTOM_CHROME, EDGE_GAP, MIN_GAP]);

  if (!raw.found) throw new Error(`на странице нет #${targetId}`);
  const { track, ...rest } = raw;
  return {
    miss: raw.top - raw.expectedOffset,
    ...rest,
    ...analyzeTrack(track),
    samples: track ? track.samples.slice(-2000) : [],
  };
}

/** Общее окружение без якоря — для logo-click и reload. */
async function measureState(page) {
  const raw = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    docHeight: Math.round(document.documentElement.scrollHeight),
    pinSpacer: !!document.querySelector('.pin-spacer'),
    cvOff: document.documentElement.classList.contains('cv-off'),
    track: window.__aaTrack ? { t0: window.__aaTrack.t0, samples: window.__aaTrack.samples.slice(-2000) } : null,
  }));
  const { track, ...rest } = raw;
  return { ...rest, ...analyzeTrack(track), samples: track ? track.samples.slice(-2000) : [] };
}

/**
 * «Что сейчас под верхом экрана»: секция с id под точкой (ширина/2, 100) и
 * глубина входа в неё. Если под точкой оказалась фиксированная шапка (на
 * узком экране она бывает выше 100 px) — щупаем ниже её края.
 */
async function probeLandmark(page, probeY = PROBE_Y) {
  return page.evaluate(([y0, headerSel]) => {
    const header = document.querySelector(headerSel);
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
    const y = headerBottom > y0 ? Math.round(headerBottom + 24) : y0;
    const hit = document.elementFromPoint(Math.round(window.innerWidth / 2), y);
    let node = hit;
    while (node && node !== document.body && !(node.id && node.id.length)) node = node.parentElement;
    const id = node && node.id ? node.id : null;
    const rect = id ? document.getElementById(id).getBoundingClientRect() : null;
    return { id, probeY: y, depth: rect ? Math.round(y - rect.top) : null, scrollY: Math.round(window.scrollY) };
  }, [probeY, TOP_CHROME]);
}

/** Глубина входа в КОНКРЕТНУЮ секцию — чтобы сравнивать «до» и «после». */
async function depthInside(page, id, probeY) {
  return page.evaluate(([sectionId, y]) => {
    const el = document.getElementById(sectionId);
    if (!el) return null;
    return Math.round(y - el.getBoundingClientRect().top);
  }, [id, probeY]);
}

/** Ждём, пока прокрутка перестанет меняться `quietMs` подряд. */
async function waitScrollQuiet(page, quietMs = 1200, timeoutMs = 10_000) {
  const started = Date.now();
  let last = await page.evaluate(() => Math.round(window.scrollY));
  let lastChange = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(120);
    const y = await page.evaluate(() => Math.round(window.scrollY));
    if (y !== last) {
      last = y;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return last;
    }
  }
  return last;
}

const resetTrack = (page) => page.evaluate(() => window.__aaTrackReset && window.__aaTrackReset());

/**
 * Куда прокрутить, чтобы оказаться «глубоко на странице». Прародитель стенда
 * жёстко скроллил на 7000 px — на короткой странице стартера это просто «в
 * самый низ», а иногда и «никуда» (документ ниже упора не едет), и сценарии
 * reload/logo-click мерили бы вырожденный случай. Берём долю документа.
 */
async function scrollDeep(page, fraction = 0.55) {
  return page.evaluate((f) => {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const y = Math.round(Math.min(max, Math.max(600, max * f)));
    window.scrollTo(0, y);
    return y;
  }, fraction);
}

/* ------------------------------------------------------------ взаимодействия */

/**
 * Видимость ссылок с данным href внутри контейнера — и почему не
 * `locator.isVisible()`.
 *
 * У стартера мобильное меню свёрнуто гридом (`grid-rows-[0fr]` +
 * `overflow: hidden`, Header.astro:88), а не `display: none`. Ссылки внутри
 * него сохраняют НЕНУЛЕВОЙ прямоугольник — их просто обрезает предок. Для
 * Playwright такой узел «видим», и стенд, доверившись `isVisible()`, кликал бы
 * по невидимому человеку пункту свёрнутого меню вместо того, чтобы открыть
 * бургер. Поэтому проверяем попаданием: `elementFromPoint` в центре ссылки
 * должен вернуть её саму или её потомка. Обрезку предком и перекрытие чужим
 * фиксированным блоком эта проверка ловит, `isVisible()` — нет.
 */
async function inspectLinks(page, scopeSelector, href) {
  return page.evaluate(([scope, wanted, menuSel]) => {
    // Корней ДВА, и это не мелочь. У одних сайтов мобильное меню лежит внутри
    // шапки (astro-starter), у других — соседним узлом сразу за ней
    // (боевой проект: `<header id="site-header">` и `<nav id="mobile-menu">` —
    // братья). Искать только внутри шапки значило бы не найти ни одного пункта
    // мобильного меню и упереться в скрытую десктопную ссылку: клик по ней
    // уходит в «Element is not visible», а клетка — в ERR.
    //
    // Порядок корней задаёт и порядок индексов, поэтому оба ниже опрашиваются
    // одним списком: индекс из этого списка потом адресует ту же ссылку в
    // locator'е.
    const roots = [document.querySelector(scope), document.querySelector(menuSel)].filter(Boolean);
    const links = [];
    for (const root of roots) {
      for (const a of root.querySelectorAll('a[href]')) {
        if ((a.getAttribute('href') || '') !== wanted) continue;
        if (!links.includes(a)) links.push(a);
      }
    }
    return links.map((a, index) => {
      const rect = a.getBoundingClientRect();
      let seen = false;
      if (rect.width > 0 && rect.height > 0) {
        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top + rect.height / 2);
        if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
          const hit = document.elementFromPoint(cx, cy);
          seen = !!hit && (hit === a || a.contains(hit));
        }
      }
      return { index, seen, inMenu: !!a.closest(menuSel) };
    });
  }, [scopeSelector, href, MOBILE_MENU]);
}

/**
 * Клик по пункту меню. На узком экране горизонтальной навигации нет — там тот
 * же пункт живёт в бургер-меню, и это и есть настоящий путь человека, а не
 * обходной трюк стенда. Возвращает, каким путём кликнули, — это идёт в отчёт,
 * потому что промах у двух путей бывает разный.
 */
async function clickHeaderAnchor(page, href) {
  // Тот же двойной корень, что и в `inspectLinks`, и в том же порядке —
  // индексы оттуда адресуют элементы здесь.
  const locator = page.locator(
    `${TOP_CHROME} a[href="${href}"], ${MOBILE_MENU} a[href="${href}"]`,
  );

  // 1. Ссылка прямо в шапке, вне свёрнутого меню.
  let links = await inspectLinks(page, TOP_CHROME, href);
  const direct = links.find((l) => l.seen && !l.inMenu);
  if (direct) {
    await locator.nth(direct.index).click({ timeout: ACT_TIMEOUT_MS });
    return 'шапка';
  }

  // 2. Мобильный путь: открыть бургер и кликнуть пункт в раскрывшемся меню.
  const burger = page.locator(BURGER).first();
  if ((await burger.count()) > 0 && (await burger.isVisible())) {
    await burger.click({ timeout: ACT_TIMEOUT_MS });
    await sleep(700); // 300 мс анимации раскрытия + запас на медленной машине
    links = await inspectLinks(page, TOP_CHROME, href);
    const inMenu = links.find((l) => l.seen && l.inMenu) || links.find((l) => l.inMenu);
    if (inMenu) {
      await locator.nth(inMenu.index).click({ timeout: ACT_TIMEOUT_MS });
      return 'бургер-меню';
    }
  }

  // 3. Последний шанс: кликнуть силой, чтобы клетка дала цифру, а не ERR.
  if ((await locator.count()) === 0) throw new Error(`в шапке нет ссылки ${href}`);
  await locator.first().click({ timeout: ACT_TIMEOUT_MS, force: true });
  return 'шапка (force)';
}

/**
 * Возвращает шапку на экран. Стартер умеет прятать её при прокрутке вниз
 * (проп `autoHide` → класс `hdr-away`, `transform: translateY(-100%)`), и
 * тогда логотип физически вне экрана — кликнуть по нему нельзя ни человеку,
 * ни стенду, клик уходит в таймаут. Человек в этом случае подкручивает вверх,
 * шапка выезжает, и только тогда он жмёт логотип; стенд повторяет ровно это.
 * Возвращает, пришлось ли подкручивать (факт идёт в отчёт: подкрутка меняет
 * стартовую позицию, и без пометки цифра «до клика» выглядела бы странной).
 */
async function revealHeader(page) {
  const onScreen = () =>
    page.evaluate((headerSel) => {
      const header = document.querySelector(headerSel);
      return !!header && header.getBoundingClientRect().top >= -1;
    }, TOP_CHROME);
  if (await onScreen()) return false;
  for (let i = 0; i < 8; i += 1) {
    await page.evaluate(() => window.scrollBy(0, -180));
    await sleep(350);
    if (await onScreen()) return true;
  }
  return true;
}

/** Дроссель холодного захода. Возвращает описание способа для отчёта. */
async function applyColdThrottle(context, page, engineId) {
  if (engineId === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (900 * 1024) / 8,
      uploadThroughput: (900 * 1024) / 8,
    });
    return 'CDP: 900 кбит/с, +150 мс, кэш выключен';
  }
  // CDP нет — задерживаем каждый ответ и запрещаем кэш заголовками.
  await context.route('**/*', async (route) => {
    await sleep(150);
    try {
      await route.continue({
        headers: { ...route.request().headers(), 'cache-control': 'no-cache', pragma: 'no-cache' },
      });
    } catch {
      /* контекст закрылся посреди запроса — клетка уже измерена */
    }
  });
  return 'route(): +150 мс на запрос, no-cache (полоса не ограничена)';
}

/* ------------------------------------------------------------------ сценарии */

async function scenarioColdHash(ctx) {
  const { page, context, engineId, base, plan } = ctx;
  if (!plan.anchor) skip('в шапке нет якорных ссылок на главную');
  const throttle = await applyColdThrottle(context, page, engineId);
  await page.goto(`${base}/#${plan.anchor.id}`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  await sleep(6000);
  const m = await measureAnchor(page, plan.anchor.id);
  return { miss: m.miss, targetId: plan.anchor.id, how: throttle, ...m };
}

async function scenarioMenuClick(ctx) {
  const { page, base, plan } = ctx;
  if (!plan.anchor) skip('в шапке нет якорных ссылок на главную');
  await page.goto(`${base}/`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  await sleep(3000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  await resetTrack(page);
  const how = await clickHeaderAnchor(page, plan.anchor.href);
  await sleep(3000);
  const m = await measureAnchor(page, plan.anchor.id);
  return { miss: m.miss, targetId: plan.anchor.id, how: `клик: ${how}`, ...m };
}

async function scenarioFooterClick(ctx) {
  const { page, base, plan } = ctx;
  if (!plan.footer) skip('в подвале нет якорной ссылки на главную');
  if (!plan.footer.exists) skip(`ссылка подвала ${plan.footer.href} ведёт в никуда — нет #${plan.footer.id}`);
  await page.goto(`${base}/`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  await sleep(3000);
  const locator = page.locator(`footer a[href="${plan.footer.href}"]`).first();
  // Довозим ссылку до экрана ОТДЕЛЬНО от клика: иначе автопрокрутка Playwright
  // попадёт в траекторию и притворится лишним «движением».
  await locator.scrollIntoViewIfNeeded({ timeout: ACT_TIMEOUT_MS });
  await waitScrollQuiet(page, 800, 6000);
  await resetTrack(page);
  await locator.click({ timeout: ACT_TIMEOUT_MS });
  await sleep(3000);
  const m = await measureAnchor(page, plan.footer.id);
  return { miss: m.miss, targetId: plan.footer.id, how: `ссылка подвала ${plan.footer.href}`, ...m };
}

async function scenarioReload(ctx) {
  const { page, base } = ctx;
  await page.goto(`${base}/`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  await sleep(2000);
  await scrollDeep(page);
  const before = await waitScrollQuiet(page, 1200, 12_000);
  const mark = await probeLandmark(page);
  await page.reload({ waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  await sleep(3000);
  const state = await measureState(page);
  const after = await probeLandmark(page);

  // Промах — сдвиг ПО КОНТЕНТУ: насколько глубже/выше стоит верх экрана
  // относительно той же секции. Голый scrollY тут врёт: документ после
  // перезагрузки другой высоты, пока раскладка не доехала.
  let miss;
  let how;
  if (mark.id) {
    const depthAfter = await depthInside(page, mark.id, after.probeY);
    if (depthAfter === null) {
      miss = state.scrollY - before;
      how = `секция #${mark.id} исчезла — мерено по scrollY`;
    } else {
      miss = depthAfter - mark.depth;
      how =
        `ориентир #${mark.id}: было ${mark.depth} px вглубь, стало ${depthAfter} px` +
        (after.id === mark.id ? '' : `; под верхом теперь #${after.id ?? '—'}`);
    }
  } else {
    miss = state.scrollY - before;
    how = 'секции с id под верхом экрана нет — мерено по scrollY';
  }
  return { miss, targetId: mark.id, how, scrollYBefore: before, ...state, expectedOffset: null, top: null };
}

async function scenarioLogoClick(ctx) {
  const { page, base, plan } = ctx;
  if (!plan.logo) skip('в шапке нет ссылки-логотипа на главную');
  await page.goto(`${base}/`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  await sleep(2000);
  await scrollDeep(page, 0.6);
  await waitScrollQuiet(page, 1000, 10_000);
  const nudged = await revealHeader(page);
  const before = await waitScrollQuiet(page, 800, 8000);
  await resetTrack(page);
  await page.locator(plan.logo.selector).first().click({ timeout: ACT_TIMEOUT_MS });
  await sleep(2000);
  const state = await measureState(page);
  return {
    miss: state.scrollY, // цель логотипа — ровно ноль
    targetId: null,
    how:
      `цель — верх страницы (scrollY=0); логотип: ${plan.logo.how}; до клика scrollY=${before}` +
      (nudged ? '; шапку пришлось вернуть на экран подкруткой вверх' : ''),
    scrollYBefore: before,
    ...state,
    expectedOffset: null,
    top: null,
  };
}

async function scenarioCrossPageHash(ctx) {
  const { page, base, plan } = ctx;
  if (!plan.anchor) skip('в шапке нет якорных ссылок на главную');
  if (!plan.inner) skip('в шапке нет ссылки на внутреннюю страницу');
  await page.goto(`${base}${plan.inner.path}`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  await sleep(2500);
  const how = await clickHeaderAnchor(page, plan.anchor.href);
  await sleep(3000);
  try {
    await page.waitForLoadState('load', { timeout: 30_000 });
  } catch {
    /* SPA-переход ClientRouter события load не даёт — это нормально */
  }
  const m = await measureAnchor(page, plan.anchor.id);
  return { miss: m.miss, targetId: plan.anchor.id, how: `с ${plan.inner.path}, клик: ${how}`, ...m };
}

const RUNNERS = {
  'cold-hash': scenarioColdHash,
  'menu-click': scenarioMenuClick,
  'footer-click': scenarioFooterClick,
  reload: scenarioReload,
  'logo-click': scenarioLogoClick,
  'cross-page-hash': scenarioCrossPageHash,
};

/* --------------------------------------------------------------- прогон клетки */

/**
 * Одна клетка таблицы. Свой контекст на каждую — состояние (кэш, история,
 * позиция прокрутки, открытое меню) между сценариями не протекает. Падение
 * клетки не роняет прогон: в таблицу уходит ERR, остальное меряется дальше.
 */
async function runCell(engineId, browser, viewport, scenario, base, plan) {
  let context = null;
  try {
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      // isMobile/hasTouch намеренно не ставим: firefox их не поддерживает,
      // а мерить надо одним и тем же на всех трёх движках.
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
    });
    context.setDefaultTimeout(ACT_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await context.addInitScript(trackInit);
    const page = await context.newPage();
    const result = await RUNNERS[scenario]({ page, context, engineId, base, viewport, plan });
    // `ran` — «сценарий отработал без исключения», НЕ «промах в допуске».
    // Вердикт по допуску считается отдельно, в сводке: клетка может честно
    // отработать и при этом промахнуться на две тысячи пикселей.
    return { ran: true, ...result };
  } catch (error) {
    if (error instanceof SkipScenario) {
      // Сценарий не запускался осознанно: на этом сайте ему нечего мерить.
      // `ran: false` тут честнее, чем `true`, а отдельный флаг `skipped`
      // держит такую клетку вне вердикта — это не провал.
      return { ran: false, skipped: true, skipReason: error.message };
    }
    return {
      ran: false,
      skipped: false,
      error: String(error && error.message ? error.message : error).split('\n')[0].slice(0, 160),
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------- печать */

const pad = (text, width) => text + ' '.repeat(Math.max(0, width - [...text].length));

function cellText(cell) {
  if (!cell) return '—';
  if (cell.skipped) return 'SKIP';
  if (!cell.ran) return `ERR: ${cell.error.slice(0, 22)}`;
  const mark = cell.travelPhases >= 2 ? ' *' : '';
  return `${cell.miss > 0 ? '+' : ''}${cell.miss} px${mark}`;
}

function printTable(results, args) {
  const cols = args.browsers;
  const rows = [];
  for (const scenario of args.scenarios) {
    for (const viewportId of args.viewports) {
      rows.push({ scenario, viewportId });
    }
  }
  const w0 = Math.max(9, ...rows.map((r) => r.scenario.length));
  const w1 = Math.max(7, ...rows.map((r) => r.viewportId.length));
  const colW = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => [...cellText(results[`${r.scenario}|${r.viewportId}|${c}`])].length)),
  );

  const head = `${pad('сценарий', w0)}  ${pad('вьюпорт', w1)}  ${cols.map((c, i) => pad(c, colW[i])).join('  ')}`;
  console.log(head);
  console.log('-'.repeat([...head].length));
  for (const row of rows) {
    const cells = cols.map((c, i) => pad(cellText(results[`${row.scenario}|${row.viewportId}|${c}`]), colW[i]));
    console.log(`${pad(row.scenario, w0)}  ${pad(row.viewportId, w1)}  ${cells.join('  ')}`);
  }
  console.log('');
  console.log(
    `* — прокрутка шла в ≥2 приёма (пауза ≥${PHASE_GAP_MS} мс между движениями): «сначала первый экран, потом перелистнулось».`,
  );
  console.log('SKIP — на этом сайте сценарию нечего мерить (см. подробности ниже); в вердикт не входит.');
}

function printDetails(results, args) {
  console.log('');
  console.log('Подробности по клеткам');
  console.log('======================');
  for (const scenario of args.scenarios) {
    for (const viewportId of args.viewports) {
      for (const browserId of args.browsers) {
        const cell = results[`${scenario}|${viewportId}|${browserId}`];
        if (!cell) continue;
        const head = `${scenario} / ${viewportId} / ${browserId}`;
        if (cell.skipped) {
          console.log(`${head}: SKIP — ${cell.skipReason}`);
          continue;
        }
        if (!cell.ran) {
          console.log(`${head}: ERR ${cell.error}`);
          continue;
        }
        const bits = [
          `промах ${cell.miss > 0 ? '+' : ''}${cell.miss} px`,
          `цель ${cell.targetId ? `#${cell.targetId}` : '—'}`,
          `scrollY ${cell.scrollY}`,
          `документ ${cell.docHeight} px`,
          `пин ${cell.pinSpacer ? 'есть' : 'нет'}`,
          `cv-off ${cell.cvOff ? 'да' : 'нет'}`,
          `движений ${cell.travelPhases}`,
          `замерло за ${cell.settleMs === null ? '—' : `${cell.settleMs} мс`}`,
        ];
        if (cell.expectedOffset !== null && cell.expectedOffset !== undefined) {
          bits.push(
            `ожидаемый отступ ${cell.expectedOffset} px (шапка ${cell.headerH} + ${EDGE_GAP} + ${MIN_GAP} + scroll-margin-top ${cell.scrollMarginTop})`,
          );
        }
        if (cell.bottomChromeH) bits.push(`обвязка снизу ${cell.bottomChromeH} px`);
        console.log(`${head}: ${bits.join(', ')}`);
        if (cell.how) console.log(`${' '.repeat(2)}${cell.how}`);
      }
    }
  }
}

/** Шапка отчёта: что стенд нашёл сам. Без неё цифры нечитаемы через месяц. */
function printPlan(plan) {
  console.log('Разведка (что стенд нашёл на главной сам)');
  console.log('=========================================');
  if (plan.anchor) {
    console.log(`якорь-цель:        #${plan.anchor.id}  (ссылка ${plan.anchor.href}) — ${plan.anchorHow}`);
  } else {
    console.log('якорь-цель:        НЕ НАЙДЕН — якорные сценарии будут помечены SKIP');
  }
  const others = plan.anchorCandidates
    .map((a) => `#${a.id}${a.top === null ? ' (цели нет на странице)' : ` @${a.top}`}`)
    .join(', ');
  console.log(`якоря шапки:       ${others || '—'}`);
  console.log(`внутренняя стр.:   ${plan.inner ? plan.inner.path : 'НЕ НАЙДЕНА — cross-page-hash → SKIP'}`);
  console.log(
    `ссылка подвала:    ${
      plan.footer ? `${plan.footer.href}${plan.footer.exists ? '' : ' (цели нет!)'}` : 'НЕ НАЙДЕНА — footer-click → SKIP'
    }`,
  );
  console.log(`логотип:           ${plan.logo ? `${plan.logo.selector} — ${plan.logo.how}` : 'НЕ НАЙДЕН — logo-click → SKIP'}`);
  console.log(`обвязка:           сверху ${TOP_CHROME}, снизу ${BOTTOM_CHROME}`);
  console.log(`высота документа:  ${plan.docHeight} px (десктоп 1440×900)`);
  console.log('');
}

/* --------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'node scripts/anchor-audit.mjs [--base URL] [--anchor id] [--browsers a,b,c]\n' +
        '                              [--viewports desktop,mobile] [--scenarios ...]\n' +
        '                              [--json path] [--no-fail-exit]\n' +
        '\n' +
        '  --base      корень сайта, по умолчанию http://localhost:4321\n' +
        `  --anchor    id секции-цели вручную; без флага берётся самый глубокий якорь ${TOP_CHROME}\n` +
        `  --browsers  ${Object.keys(ENGINES).join(',')}\n` +
        `  --viewports ${VIEWPORTS.map((v) => `${v.id} (${v.width}×${v.height})`).join(', ')}\n` +
        `  --scenarios ${SCENARIOS.join(',')}\n` +
        '  --json      куда сложить сырые замеры\n' +
        '  --no-fail-exit  всегда возвращать 0 (снятие базовой линии «до правки»)',
    );
    return 0;
  }

  console.log(`Стенд якорной навигации: ${args.base}`);
  console.log(
    `браузеры: ${args.browsers.join(', ')} · вьюпорты: ${args.viewports.join(', ')} · сценариев: ${args.scenarios.length}`,
  );
  console.log(`критерий приёмки: |промах| ≤ ${PASS_PX} px в каждой клетке`);
  console.log('');

  // Разведка идёт в первом же доступном движке: структура разметки от движка
  // не зависит, а поднимать ради неё все три — впустую тратить минуту.
  let plan = null;
  for (const engineId of args.browsers) {
    let browser = null;
    try {
      browser = await ENGINES[engineId].launch({ headless: true });
      plan = await discover(browser, args.base, args.anchor);
      break;
    } catch (error) {
      console.log(`[${engineId}] разведка не удалась: ${String(error && error.message ? error.message : error).split('\n')[0]}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
  if (!plan) {
    console.error('Разведка не удалась ни в одном движке — сайт не открылся. Стенд остановлен.');
    return 1;
  }
  printPlan(plan);

  const results = {};
  const raw = [];

  for (const engineId of args.browsers) {
    let browser = null;
    try {
      browser = await ENGINES[engineId].launch({ headless: true });
    } catch (error) {
      const message = String(error && error.message ? error.message : error).split('\n')[0].slice(0, 160);
      console.log(`[${engineId}] не запустился: ${message}`);
      for (const scenario of args.scenarios) {
        for (const viewportId of args.viewports) {
          results[`${scenario}|${viewportId}|${engineId}`] = { ran: false, skipped: false, error: `запуск: ${message}` };
        }
      }
      continue;
    }
    try {
      for (const viewportId of args.viewports) {
        const viewport = VIEWPORTS.find((v) => v.id === viewportId);
        for (const scenario of args.scenarios) {
          const started = Date.now();
          process.stdout.write(`[${engineId}/${viewportId}] ${scenario} … `);
          const cell = await runCell(engineId, browser, viewport, scenario, args.base, plan);
          results[`${scenario}|${viewportId}|${engineId}`] = cell;
          raw.push({ browser: engineId, viewport: viewportId, scenario, tookMs: Date.now() - started, ...cell });
          if (cell.skipped) console.log(`SKIP (${cell.skipReason})`);
          else if (cell.ran) console.log(`${cellText(cell)} (${Math.round((Date.now() - started) / 1000)} с)`);
          else console.log(`ERR ${cell.error}`);
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  console.log('');
  console.log('Промах якорной навигации, px (0 — секция ровно под шапкой)');
  console.log('==========================================================');
  printTable(results, args);
  printDetails(results, args);

  const failures = [];
  let measured = 0;
  let skipped = 0;
  for (const scenario of args.scenarios) {
    for (const viewportId of args.viewports) {
      for (const browserId of args.browsers) {
        const cell = results[`${scenario}|${viewportId}|${browserId}`];
        if (!cell) continue;
        if (cell.skipped) {
          skipped += 1;
          continue;
        }
        measured += 1;
        if (!cell.ran) failures.push(`${scenario} / ${viewportId} / ${browserId}: ERR ${cell.error}`);
        else if (Math.abs(cell.miss) > PASS_PX) {
          failures.push(`${scenario} / ${viewportId} / ${browserId}: ${cell.miss > 0 ? '+' : ''}${cell.miss} px`);
        }
      }
    }
  }

  const tail = skipped ? `; SKIP-клеток: ${skipped} — мерить нечего` : '';
  console.log('');
  if (failures.length === 0) {
    console.log(`ИТОГ: PASS — во всех ${measured} измеренных клетках |промах| ≤ ${PASS_PX} px${tail}.`);
  } else {
    console.log(`ИТОГ: FAIL — ${failures.length} из ${measured} измеренных клеток вне допуска ±${PASS_PX} px${tail}:`);
    for (const line of failures) console.log(`  · ${line}`);
  }

  if (args.json) {
    writeFileSync(
      args.json,
      `${JSON.stringify(
        {
          base: args.base,
          at: new Date().toISOString(),
          passPx: PASS_PX,
          plan: { anchor: plan.anchor, anchorHow: plan.anchorHow, inner: plan.inner, footer: plan.footer, logo: plan.logo },
          cells: raw,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`Сырые замеры: ${args.json}`);
  }

  return failures.length > 0 && args.failExit ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`стенд упал: ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  });
