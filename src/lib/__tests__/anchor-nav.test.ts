// @vitest-environment jsdom
/**
 * ============================================================================
 *  anchor-nav.ts — что здесь вообще можно проверить без браузера.
 * ----------------------------------------------------------------------------
 *  Модуль почти целиком состоит из DOM-обвязки, и изображать браузер там, где
 *  его нет, смысла не имеет: `scrollToElement` в jsdom не сработает — нет
 *  раскладки, нет `getBoundingClientRect` с настоящими числами, нет rAF-цикла
 *  доводки. Поэтому `../scroll-to` здесь замокан целиком, и проверяется ровно
 *  то, что принадлежит САМОМУ anchor-nav:
 *
 *   1. РЕШЕНИЕ «вести или не вести». `landOn` обязан сначала убедиться, что
 *      цель есть, и только потом будить раскладку. Обратный порядок — это
 *      снятый со всей страницы `content-visibility` и разбуженные ленивые
 *      сцены ради якоря, которого нет: работа оплачена, раскладка изменена
 *      под браузером, которому мы этот клик сейчас же вернём.
 *
 *   2. РЕЕСТР ЦЕЛЕЙ. Секция вправе знать про свою раскладку больше модуля:
 *      карточка формы регистрирует `block: 'fit'`, чтобы попасть в экран
 *      целиком между шапкой и липким островом, а не встать верхом под шапку.
 *      Проверяем, что резолвер действительно перебивает поиск по id и что его
 *      `opts` доезжают до `scrollToElement`.
 *
 *   3. КОНТРАКТ `PREPARE_EVENT`. Это единственная ниточка между модулем и
 *      ленивыми сценами, которые обязаны построиться немедленно, не дожидаясь
 *      приближения к экрану (scroll-pitfalls.md §4). Имя события — публичный
 *      контракт: переименовали втихую — сцены перестали строиться вовремя, и
 *      все якоря ниже сцены разом уехали на её высоту. Отсюда явная проверка
 *      строкового значения, а не только «событие приходит».
 *
 *   4. РАЗБОР ХЕША. Экспортируемого хелпера нет, поэтому percent-encoding и
 *      пустой хеш проверяются через публичное поведение `landOn`.
 *
 *  Разбор, из которого модуль вырос: docs/recipes/scroll-pitfalls.md §4, §9, §10.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../scroll-to', () => ({
  scrollToElement: vi.fn(),
  cancelScrollTo: vi.fn(),
}));

/** Класс-предохранитель `content-visibility` (правило `:root.cv-off`). */
const CV_CLASS = 'cv-off';

/** Имя события — контракт с ленивыми сценами, а не деталь реализации. */
const EXPECTED_PREPARE_EVENT = 'anchor:prepare';

/** Настройки, с которыми `landOn` зовёт прокрутку по умолчанию: мгновенно и
 *  верхом под шапку — ровно то, что делает нативный якорь браузера. */
const DEFAULT_SCROLL_OPTS = { animate: false, block: 'start' };

/**
 * Реестр резолверов живёт в переменной модуля и не умеет разрегистрировать
 * цель, поэтому каждый тест получает СВОЙ экземпляр модуля. Заодно это
 * гарантирует, что `../scroll-to` в тесте и в anchor-nav — один и тот же мок.
 */
async function loadModule() {
  vi.resetModules();
  const scrollTo = await import('../scroll-to');
  const nav = await import('../anchor-nav');
  return { nav, scrollToElement: vi.mocked(scrollTo.scrollToElement) };
}

/** Сколько раз прилетело `anchor:prepare` с момента подписки. */
function watchPrepare(): { count: () => number; stop: () => void } {
  let n = 0;
  const on = (): void => {
    n += 1;
  };
  document.addEventListener(EXPECTED_PREPARE_EVENT, on);
  return { count: () => n, stop: () => document.removeEventListener(EXPECTED_PREPARE_EVENT, on) };
}

let prepared: ReturnType<typeof watchPrepare>;

beforeEach(() => {
  // `vi.resetModules()` отдаёт свежий anchor-nav (а с ним пустой реестр
  // целей), но фабрика мока переиспользуется — счётчик вызовов гасим руками,
  // иначе он копится через весь файл.
  vi.clearAllMocks();
  document.documentElement.className = '';
  document.body.innerHTML = '';
  prepared = watchPrepare();
});

afterEach(() => {
  prepared.stop();
});

describe('PREPARE_EVENT — контракт с ленивыми сценами', () => {
  it("называется 'anchor:prepare' и переименованию не подлежит", async () => {
    const { nav } = await loadModule();
    expect(nav.PREPARE_EVENT).toBe(EXPECTED_PREPARE_EVENT);
  });
});

describe('landOn — решение «вести или не вести»', () => {
  it('несуществующий якорь: false и ни одного побочного эффекта', async () => {
    const { nav, scrollToElement } = await loadModule();

    expect(nav.landOn('#нет-такого')).toBe(false);
    // Главное в этом тесте: подготовка раскладки НЕ оплачена. Класс не встал,
    // сцены не разбужены, прокрутка не запущена — клик целиком остаётся
    // браузеру, и раскладку под ним никто не менял.
    expect(document.documentElement.classList.contains(CV_CLASS)).toBe(false);
    expect(prepared.count()).toBe(0);
    expect(scrollToElement).not.toHaveBeenCalled();
  });

  it('пустой хеш — тоже не повод будить раскладку', async () => {
    const { nav, scrollToElement } = await loadModule();

    expect(nav.landOn('#')).toBe(false);
    expect(nav.landOn('')).toBe(false);
    expect(document.documentElement.classList.contains(CV_CLASS)).toBe(false);
    expect(prepared.count()).toBe(0);
    expect(scrollToElement).not.toHaveBeenCalled();
  });

  it('существующий якорь: true, cv-off снят, prepare отправлен ровно один раз', async () => {
    document.body.innerHTML = '<section id="guarantees"></section>';
    const { nav } = await loadModule();

    expect(nav.landOn('#guarantees')).toBe(true);
    expect(document.documentElement.classList.contains(CV_CLASS)).toBe(true);
    expect(prepared.count()).toBe(1);
  });

  it('ведёт мгновенно и верхом под шапку — как нативный якорь', async () => {
    document.body.innerHTML = '<section id="guarantees"></section>';
    const { nav, scrollToElement } = await loadModule();
    const section = document.getElementById('guarantees');

    nav.landOn('#guarantees');

    expect(scrollToElement).toHaveBeenCalledTimes(1);
    expect(scrollToElement).toHaveBeenCalledWith(section, DEFAULT_SCROLL_OPTS);
  });

  it('решётка в начале необязательна', async () => {
    document.body.innerHTML = '<section id="guarantees"></section>';
    const { nav } = await loadModule();

    expect(nav.landOn('guarantees')).toBe(true);
  });
});

describe('landOn — разбор percent-encoding', () => {
  it('кириллический якорь, записанный в адресе как %D0%A0…, находится', async () => {
    document.body.innerHTML = '<section id="Гарантии"></section>';
    const { nav, scrollToElement } = await loadModule();
    const encoded = `#${encodeURIComponent('Гарантии')}`;

    // Именно так хеш и лежит в `location.hash` после клика по ссылке:
    // браузер хранит его закодированным, а `getElementById` ждёт живой id.
    expect(encoded).toBe('#%D0%93%D0%B0%D1%80%D0%B0%D0%BD%D1%82%D0%B8%D0%B8');
    expect(nav.landOn(encoded)).toBe(true);
    expect(scrollToElement).toHaveBeenCalledWith(
      document.getElementById('Гарантии'),
      DEFAULT_SCROLL_OPTS,
    );
  });

  it('битый percent-encoding не роняет модуль — id пробуется как есть', async () => {
    document.body.innerHTML = '<section id="%zz"></section>';
    const { nav } = await loadModule();

    expect(nav.landOn('#%zz')).toBe(true);
  });
});

describe('реестр целей', () => {
  it('зарегистрированный резолвер вызывается вместо поиска по id', async () => {
    document.body.innerHTML = `
      <section id="lead"></section>
      <div id="lead-card"></div>`;
    const { nav, scrollToElement } = await loadModule();
    const card = document.getElementById('lead-card')!;
    const resolve = vi.fn(() => ({ el: card }));

    nav.registerAnchorTarget('lead', resolve);

    expect(nav.landOn('#lead')).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    // Ведём к КАРТОЧКЕ, а не к секции с таким же id.
    expect(scrollToElement).toHaveBeenCalledWith(card, DEFAULT_SCROLL_OPTS);
  });

  it("opts цели перебивают умолчание: карточка формы просит block: 'fit'", async () => {
    const { nav, scrollToElement } = await loadModule();
    const card = document.createElement('div');
    document.body.append(card);

    // Знание о собственной раскладке остаётся в секции: форма должна попасть
    // в экран ЦЕЛИКОМ между шапкой и липким островом, иначе на мобильном её
    // поля уезжают под фиксированный CTA.
    nav.registerAnchorTarget('lead', () => ({ el: card, opts: { block: 'fit' } }));
    nav.landOn('#lead');

    expect(scrollToElement).toHaveBeenCalledWith(card, { animate: false, block: 'fit' });
  });

  it('повторная регистрация заменяет прежнюю цель (звать можно на каждом page-load)', async () => {
    const { nav, scrollToElement } = await loadModule();
    const first = document.createElement('div');
    const second = document.createElement('div');
    document.body.append(first, second);
    const stale = vi.fn(() => ({ el: first }));

    nav.registerAnchorTarget('lead', stale);
    nav.registerAnchorTarget('lead', () => ({ el: second }));
    nav.landOn('#lead');

    expect(stale).not.toHaveBeenCalled();
    expect(scrollToElement).toHaveBeenCalledWith(second, DEFAULT_SCROLL_OPTS);
  });

  it('резолвер вернул null — цели сейчас нет, прокрутки не будет', async () => {
    const { nav, scrollToElement } = await loadModule();

    nav.registerAnchorTarget('lead', () => null);

    expect(nav.landOn('#lead')).toBe(false);
    expect(scrollToElement).not.toHaveBeenCalled();
  });

  it('резолвер регистрируется под id, а не под хешем с решёткой', async () => {
    const { nav } = await loadModule();
    const card = document.createElement('div');
    document.body.append(card);

    nav.registerAnchorTarget('#lead', () => ({ el: card }));

    // Ключ реестра сверяется с РАСКОДИРОВАННЫМ id без решётки, поэтому
    // регистрация «с решёткой» — это просто другой, недостижимый ключ.
    expect(nav.landOn('#lead')).toBe(false);
  });
});

describe('landOnTop', () => {
  it('ведёт к body, гасит личный отступ и тоже будит раскладку', async () => {
    const { nav, scrollToElement } = await loadModule();

    nav.landOnTop();

    // Через тот же `scrollToElement`, а не одиночным `scrollTo(0, 0)`: переход
    // получает доводку и сторож раскладки даром.
    expect(scrollToElement).toHaveBeenCalledWith(document.body, {
      animate: false,
      block: 'start',
      extraTopReserve: 0,
    });
    expect(document.documentElement.classList.contains(CV_CLASS)).toBe(true);
    expect(prepared.count()).toBe(1);
  });
});
