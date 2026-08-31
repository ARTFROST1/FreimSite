/**
 * Регрессия на reduced-motion/no-IO ветку прайминга `StackedShowcase.astro`
 * (ревью W3-M, находка №4).
 *
 * Компонент прячет карточки 2+ в инертном `<template data-showcase-rest>` и
 * переносит их в живой DOM по одной, «на такт вперёд», через
 * `IntersectionObserver`. Это ПРАВИЛЬНО для декоративной экономии трафика,
 * но карточки несут самостоятельный контент (не декорацию), поэтому под
 * `prefers-reduced-motion: reduce` (и в браузерах без `IntersectionObserver`)
 * скрипт обязан достать ВСЕ карточки из `<template>` сразу, одним проходом —
 * см. doc-комментарий компонента, раздел «⚠️ ПОД prefers-reduced-motion».
 * Тест гоняет НАСТОЯЩИЙ `<script>` компонента (вытащен из .astro) в ручном
 * стабе окружения — так проверяется поведение, а не наличие нужных слов в
 * файле (тот же приём, что `yandex-map-boot.test.ts`).
 *
 * Скрипт компонента — TypeScript (Astro транспилирует его сам при сборке);
 * здесь он гоняется через `new Function` в сыром виде, поэтому типы снимает
 * `esbuild.transformSync` — без этого `document.querySelector<HTMLElement>(…)`
 * распарсился бы как цепочка сравнений (`<`/`>`), а не generic-вызов.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';

const COMPONENT = fileURLToPath(new URL('../StackedShowcase.astro', import.meta.url));

/** Тело единственного `<script>` компонента, JS после снятия типов. */
function readScript(): string {
  const src = readFileSync(COMPONENT, 'utf8');
  const match = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('в StackedShowcase.astro не найден <script>');
  return esbuild.transformSync(match[1], { loader: 'ts' }).code;
}

interface CardStub {
  tag: string;
}

interface ObserverStub {
  rootMargin: string;
  disconnected: boolean;
  observed: CardStub[];
  trigger(target: CardStub): void;
}

interface Harness {
  observers: ObserverStub[];
  /** Карточки реально в DOM-стеке, в порядке появления. Индекс 0 — первая
   *  карточка (в разметке она всегда есть, вне template). */
  stackChildren: CardStub[];
  /** Диспатчит зарегистрированные на document слушатели типа `type`
   *  (используется для имитации повторного `astro:page-load`). */
  fire(type: string): void;
}

/**
 * Прогоняет скрипт компонента с `document.readyState: 'complete'` — ветка
 * «стартуем немедленно» (см. doc-комментарий «ЗАПУСК» в самом компоненте),
 * поэтому `initShowcase()` отрабатывает синхронно внутри `run()`.
 */
function run(
  opts: { reduce?: boolean; hasIO?: boolean; pendingCount?: number } = {},
): Harness {
  const { reduce = false, hasIO = true, pendingCount = 2 } = opts;

  const listeners = new Map<string, Array<() => void>>();
  const h: Harness = {
    observers: [],
    stackChildren: [{ tag: 'card-1' }],
    fire(type) {
      for (const l of [...(listeners.get(type) ?? [])]) l();
    },
  };

  const pending: CardStub[] = Array.from({ length: pendingCount }, (_, i) => ({
    tag: `card-${i + 2}`,
  }));
  const tplStub = pendingCount > 0 ? { content: { children: pending } } : null;

  const stackEl = {
    appendChild(node: CardStub) {
      h.stackChildren.push(node);
      // Настоящий DOM `appendChild` ПЕРЕМЕЩАЕТ узел: он пропадает из
      // `<template>.content` в момент переноса (один узел — один родитель).
      // Стаб обязан повторить это, иначе повторный `initShowcase()` заново
      // нашёл бы уже перенесённые карточки в шаблоне и продублировал бы их.
      const idx = pending.indexOf(node);
      if (idx !== -1) pending.splice(idx, 1);
    },
    querySelector(sel: string) {
      if (sel === 'template[data-showcase-rest]') return tplStub;
      if (sel === '.stack-card') return h.stackChildren[0] ?? null;
      return null;
    },
  };

  const documentStub = {
    readyState: 'complete',
    addEventListener(type: string, fn: () => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== fn));
    },
    querySelector(sel: string) {
      return sel === '[data-showcase-stack]' ? stackEl : null;
    },
  };

  const windowStub = {
    matchMedia() {
      return { matches: reduce };
    },
  };

  class IntersectionObserverStub implements ObserverStub {
    rootMargin: string;
    disconnected = false;
    observed: CardStub[] = [];
    constructor(
      private cb: (entries: Array<{ isIntersecting: boolean; target: CardStub }>) => void,
      options: { rootMargin?: string } = {},
    ) {
      this.rootMargin = options.rootMargin ?? '0px';
      h.observers.push(this);
    }
    observe(target: CardStub) {
      this.observed.push(target);
    }
    unobserve(target: CardStub) {
      this.observed = this.observed.filter((t) => t !== target);
    }
    disconnect() {
      this.disconnected = true;
    }
    trigger(target: CardStub) {
      this.cb([{ isIntersecting: true, target }]);
    }
  }

  const fn = new Function('document', 'window', 'IntersectionObserver', readScript());
  fn(documentStub, windowStub, hasIO ? IntersectionObserverStub : undefined);

  return h;
}

describe('StackedShowcase — прайминг карточек 2+', () => {
  it('reduced-motion: все карточки из template достаются в DOM сразу, без наблюдателя', () => {
    const h = run({ reduce: true, pendingCount: 2 });

    expect(h.stackChildren).toHaveLength(3); // первая + обе из template
    expect(h.stackChildren.map((c) => c.tag)).toEqual(['card-1', 'card-2', 'card-3']);
    expect(h.observers).toHaveLength(0);
  });

  it('нет IntersectionObserver в окружении: то же поведение, что при reduced-motion', () => {
    const h = run({ hasIO: false, pendingCount: 2 });

    expect(h.stackChildren).toHaveLength(3);
    expect(h.observers).toHaveLength(0);
  });

  it('обычный режим: карточки НЕ извлечены до срабатывания IO, извлекаются по одной по колбэку', () => {
    const h = run({ pendingCount: 2 });

    // До какого-либо пересечения в DOM — только первая карточка (остальные
    // всё ещё инертны в <template>), а наблюдатель уже следит за ней.
    expect(h.stackChildren).toHaveLength(1);
    expect(h.observers).toHaveLength(1);
    expect(h.observers[0].observed).toEqual([{ tag: 'card-1' }]);
    expect(h.observers[0].rootMargin).toBe('100% 0px');

    // Триггерим РЕАЛЬНОЙ ссылкой из observed (не новым литералом): реальный
    // IntersectionObserver отдаёт entry.target тем же узлом, что наблюдался,
    // а unobserve(entry.target) внутри колбэка сравнивает по ссылке.

    // Первая карточка «на подходе» — прайм-ится вторая, ровно одна.
    h.observers[0].trigger(h.observers[0].observed[0]!);
    expect(h.stackChildren.map((c) => c.tag)).toEqual(['card-1', 'card-2']);
    expect(h.observers[0].observed).toEqual([{ tag: 'card-2' }]);

    // Вторая — прайм-ится третья (последняя).
    h.observers[0].trigger(h.observers[0].observed[0]!);
    expect(h.stackChildren.map((c) => c.tag)).toEqual(['card-1', 'card-2', 'card-3']);
    expect(h.observers[0].observed).toEqual([{ tag: 'card-3' }]);

    // Третья — пул исчерпан, дальнейшие пересечения ничего не ломают и не
    // теряют: ни один узел не пропал по пути.
    h.observers[0].trigger(h.observers[0].observed[0]!);
    expect(h.stackChildren.map((c) => c.tag)).toEqual(['card-1', 'card-2', 'card-3']);
  });

  it('повторный вызов initShowcase (astro:page-load следом за первичной загрузкой) гасит старый наблюдатель, не дублирует карточки', () => {
    const h = run({ pendingCount: 1 });

    // Первичная загрузка (readyState: 'complete' → initShowcase выполнился
    // синхронно внутри run()) завела ровно один живой наблюдатель.
    expect(h.observers).toHaveLength(1);
    expect(h.observers[0].disconnected).toBe(false);
    expect(h.stackChildren).toHaveLength(1); // пока ничего не прайм-илось

    // ClientRouter диспатчит astro:page-load и на первичной загрузке тоже —
    // initShowcase вызывается второй раз. guard (killShowcaseObserver() в
    // начале функции) обязан погасить первый наблюдатель ПЕРЕД тем, как
    // завести новый, иначе на странице остались бы два наблюдателя за одной
    // и той же (уже отсоединённой от актуального прохода) карточкой.
    h.fire('astro:page-load');

    expect(h.observers).toHaveLength(2);
    expect(h.observers[0].disconnected).toBe(true); // старый — погашен
    expect(h.observers[1].disconnected).toBe(false); // новый — живой
    // Карточка из template ещё ни разу не пересекала вьюпорт — второй проход
    // не должен был ничего допрайм-ить сам по себе.
    expect(h.stackChildren).toHaveLength(1);

    // Дальше работает только новый (живой) наблюдатель.
    h.observers[1].trigger(h.observers[1].observed[0]!);
    expect(h.stackChildren.map((c) => c.tag)).toEqual(['card-1', 'card-2']);
  });
});
