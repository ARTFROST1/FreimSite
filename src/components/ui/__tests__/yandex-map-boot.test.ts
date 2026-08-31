/**
 * Регрессия на ЗАПУСК Яндекс.Карты (разбор 24.08.2026).
 *
 * Что сломалось и почему тест именно такой. Карта инициализировалась строкой
 * `document.addEventListener('astro:page-load', appInitMapSection)` — и всё.
 * ClientRouter диспатчит это событие на ПЕРВИЧНОЙ загрузке по `window.load`
 * (astro/dist/transitions/router.js — `addEventListener("load", onPageLoad)`),
 * то есть после всех картинок, шрифтов и сторонних скриптов. Отсюда три бага
 * разом:
 *   1. карта появлялась через несколько секунд после того, как секция уже в кадре;
 *   2. IntersectionObserver'а до `window.load` не существовало вовсе, поэтому
 *      7-секундный сейф-таймер (он ставится внутри обсервера) не спасал;
 *   3. если человек на медленной сети успевал ПРОСКРОЛЛИТЬ МИМО секции до
 *      `window.load`, обсервер создавался на уже уехавшем элементе. IO отдаёт
 *      стартовый колбэк с isIntersecting:false и больше не срабатывает никогда —
 *      карта не грузилась до конца сессии.
 *
 * Тест гоняет НАСТОЯЩИЙ inline-скрипт компонента (вытащен из .astro) в ручном
 * стабе окружения: так проверяется поведение, а не наличие нужных слов в файле.
 * Стаб рукописный, без jsdom, — jsdom в дереве только транзитивный.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const COMPONENT = fileURLToPath(new URL('../YandexMap.astro', import.meta.url));

/** Тело `<script is:inline>` компонента — ровно то, что уезжает в браузер. */
function readInlineScript(): string {
  const src = readFileSync(COMPONENT, 'utf8');
  const match = src.match(/<script is:inline[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('в YandexMap.astro не найден <script is:inline>');
  return match[1];
}

type Listener = (event?: unknown) => void;

interface Harness {
  /** Слушатели на document по типу события. */
  listeners: Map<string, Listener[]>;
  fire(type: string): void;
  /** Сколько раз конструировали IntersectionObserver. */
  observers: Array<{ rootMargin: string; disconnected: boolean; trigger(): void }>;
  mapEl: { dataset: Record<string, string>; innerHTML: string; rectBottom: number };
  /** Теги, которые скрипт дописал в <head> (загрузчик ymaps API). */
  appendedScripts: Array<{ id: string; src: string }>;
  timers: Array<{ delay: number; fn: Listener }>;
}

/**
 * Прогоняет скрипт компонента.
 *
 * @param readyState  'loading' — скрипт исполнился во время парсинга страницы
 *                    (обычная первая загрузка); 'complete' — DOM уже готов.
 * @param rectBottom  Нижняя граница секции относительно вьюпорта.
 *                    Отрицательная — экран уже ниже карты.
 * @param mapsApiKey  Пустая строка воспроизводит текущий прод: ключа нет,
 *                    компонент обязан сразу отдать фолбэк-iframe.
 */
function run(
  opts: { readyState?: 'loading' | 'complete'; rectBottom?: number; mapsApiKey?: string } = {},
): Harness {
  const { readyState = 'loading', rectBottom = 800, mapsApiKey = 'test-key' } = opts;

  const h: Harness = {
    listeners: new Map(),
    fire(type) {
      for (const fn of [...(h.listeners.get(type) ?? [])]) fn({ type });
    },
    observers: [],
    mapEl: { dataset: {}, innerHTML: '', rectBottom },
    appendedScripts: [],
    timers: [],
  };

  const mapEl = {
    dataset: h.mapEl.dataset,
    parentElement: null,
    getBoundingClientRect: () => ({ bottom: h.mapEl.rectBottom, top: 0 }),
    set innerHTML(v: string) {
      h.mapEl.innerHTML = v;
    },
    get innerHTML() {
      return h.mapEl.innerHTML;
    },
  };

  const documentStub = {
    readyState,
    addEventListener(type: string, fn: Listener) {
      const list = h.listeners.get(type) ?? [];
      list.push(fn);
      h.listeners.set(type, list);
    },
    removeEventListener(type: string, fn: Listener) {
      const list = (h.listeners.get(type) ?? []).filter((x) => x !== fn);
      h.listeners.set(type, list);
    },
    getElementById: (id: string) => (id === 'yandex-map' ? mapEl : null),
    createElement: () => ({ id: '', src: '', onload: null, onerror: null }),
    head: {
      appendChild: (node: { id: string; src: string }) => h.appendedScripts.push(node),
    },
  };

  const windowStub = {
    ymaps: undefined,
    setTimeout: (fn: Listener, delay: number) => {
      h.timers.push({ delay, fn });
      return h.timers.length;
    },
  };

  class IntersectionObserverStub {
    rootMargin: string;
    disconnected = false;
    constructor(
      private cb: (entries: Array<{ isIntersecting: boolean }>) => void,
      options: { rootMargin?: string } = {},
    ) {
      this.rootMargin = options.rootMargin ?? '0px';
      h.observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    /** Имитирует въезд секции в кадр. */
    trigger() {
      this.cb([{ isIntersecting: true }]);
    }
  }

  const body = readInlineScript();
  const fn = new Function(
    'document',
    'window',
    'IntersectionObserver',
    'ResizeObserver',
    'requestAnimationFrame',
    'lat',
    'lng',
    'zoom',
    'markerHint',
    'markerColor',
    'mapsApiKey',
    'iframeSrc',
    'iframeFilter',
    body,
  );
  fn(
    documentStub,
    windowStub,
    IntersectionObserverStub,
    class {
      observe() {}
      disconnect() {}
    },
    (cb: Listener) => cb(),
    45.03,
    39.12,
    11,
    'хинт',
    '#862B33',
    mapsApiKey,
    'https://yandex.ru/map-widget/v1/?ll=1%2C2',
    'filter: grayscale(1);',
  );

  return h;
}

describe('YandexMap — точка запуска', () => {
  it('НЕ ждёт astro:page-load (он приходит по window.load): вешается на DOMContentLoaded', () => {
    const h = run({ readyState: 'loading' });

    // До готовности DOM наблюдателя ещё нет — это нормально...
    expect(h.observers).toHaveLength(0);
    expect(h.listeners.get('DOMContentLoaded') ?? []).toHaveLength(1);

    // ...но он появляется по DOMContentLoaded, а не по window.load.
    h.fire('DOMContentLoaded');
    expect(h.observers).toHaveLength(1);
  });

  it('скрипт исполнился уже после парсинга — стартует немедленно, без ожидания событий', () => {
    const h = run({ readyState: 'complete' });
    expect(h.observers).toHaveLength(1);
  });

  it('astro:page-load после DOMContentLoaded не создаёт вторую карту', () => {
    const h = run({ readyState: 'loading' });
    h.fire('DOMContentLoaded');
    h.fire('astro:page-load');

    expect(h.observers).toHaveLength(1);
    expect(h.mapEl.dataset.mapBooted).toBe('1');
  });

  it('SPA-переход всё ещё поднимает карту: astro:page-load остаётся подписан', () => {
    const h = run({ readyState: 'loading' });
    expect(h.listeners.get('astro:page-load') ?? []).toHaveLength(1);
  });
});

describe('YandexMap — секция уже за спиной', () => {
  it('экран ниже карты: грузим сразу, а не ждём несуществующего пересечения', () => {
    // Ровно тот случай, когда карта не появлялась вовсе: IO на уехавшем вверх
    // элементе отдаёт isIntersecting:false и молчит до обратной прокрутки.
    const h = run({ readyState: 'complete', rectBottom: -500 });

    expect(h.observers).toHaveLength(0);
    expect(h.appendedScripts).toHaveLength(1);
    expect(h.appendedScripts[0].id).toBe('ymaps-api-script');
  });

  it('без ключа API та же ветка сразу отдаёт фолбэк-iframe', () => {
    const h = run({ readyState: 'complete', rectBottom: -500, mapsApiKey: '' });

    expect(h.appendedScripts).toHaveLength(0);
    expect(h.mapEl.innerHTML).toContain('<iframe');
    // Вставляется уже во вьюпорте — «ленивость» тут только добавляет задержку.
    expect(h.mapEl.innerHTML).toContain('loading="eager"');
  });
});

describe('YandexMap — ленивость и уборка', () => {
  it('пока секция не в кадре, ни API, ни iframe не грузятся', () => {
    const h = run({ readyState: 'complete' });
    expect(h.appendedScripts).toHaveLength(0);
    expect(h.mapEl.innerHTML).toBe('');
    // И сейф-таймер тоже не заведён: иначе через 7с на каждой странице с
    // картой подтягивался бы тяжёлый map-widget, даже если до неё не дошли.
    expect(h.timers).toHaveLength(0);
  });

  it('запас rootMargin — не меньше 600px, чтобы успеть до въезда в кадр', () => {
    const h = run({ readyState: 'complete' });
    expect(parseInt(h.observers[0].rootMargin, 10)).toBeGreaterThanOrEqual(600);
  });

  it('пересечение заводит и загрузку API, и сейф-таймер на 7с', () => {
    const h = run({ readyState: 'complete' });
    h.observers[0].trigger();

    expect(h.observers[0].disconnected).toBe(true);
    expect(h.appendedScripts).toHaveLength(1);
    expect(h.timers.map((t) => t.delay)).toEqual([7000]);
  });

  it('уход со страницы SPA-переходом отцепляет наблюдателя', () => {
    const h = run({ readyState: 'complete' });
    h.fire('astro:before-swap');
    expect(h.observers[0].disconnected).toBe(true);
  });
});
