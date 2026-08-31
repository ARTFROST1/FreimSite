/**
 * Регрессия на JS-механику `BeforeAfter.astro`: input-слушатель обязан писать
 * CSS-переменную `--ba-pos` на контейнер и обновлять `aria-valuetext` («N %»),
 * а повторные вызовы init (DOMContentLoaded + astro:page-load на первичной
 * загрузке) — не вешать вторые слушатели (guard `data-ready`).
 *
 * Тест гоняет НАСТОЯЩИЙ `<script>` компонента (вытащен из .astro) в ручном
 * стабе окружения — проверяется поведение, а не наличие нужных слов в файле
 * (тот же приём, что `stacked-showcase-boot.test.ts` / `yandex-map-boot.test.ts`).
 *
 * Скрипт компонента — TypeScript (Astro транспилирует его при сборке); здесь
 * он гоняется через `new Function` в сыром виде, поэтому типы снимает
 * `esbuild.transformSync` — без этого generic-вызовы
 * `querySelectorAll<HTMLElement>(…)` распарсились бы как цепочки сравнений.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';

const COMPONENT = fileURLToPath(new URL('../BeforeAfter.astro', import.meta.url));

/** Тело единственного `<script>` компонента, JS после снятия типов. */
function readScript(): string {
  const src = readFileSync(COMPONENT, 'utf8');
  const match = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('в BeforeAfter.astro не найден <script>');
  return esbuild.transformSync(match[1], { loader: 'ts' }).code;
}

interface RangeStub {
  value: string;
  /** Все навешенные input-слушатели — по одному на корректную привязку. */
  inputListeners: Array<() => void>;
  attrs: Record<string, string>;
  addEventListener(type: string, fn: () => void): void;
  setAttribute(name: string, value: string): void;
}

interface RootStub {
  dataset: Record<string, string | undefined>;
  /** CSS-переменные, записанные style.setProperty. */
  vars: Record<string, string>;
  style: { setProperty(name: string, value: string): void };
  querySelector(sel: string): RangeStub | null;
  range: RangeStub;
}

function makeRoot(): RootStub {
  const range: RangeStub = {
    value: '50',
    inputListeners: [],
    attrs: {},
    addEventListener(type, fn) {
      if (type === 'input') range.inputListeners.push(fn);
    },
    setAttribute(name, value) {
      range.attrs[name] = value;
    },
  };
  const root: RootStub = {
    dataset: {},
    vars: {},
    range,
    style: {
      setProperty(name, value) {
        root.vars[name] = value;
      },
    },
    querySelector(sel) {
      return sel === 'input[type="range"]' ? range : null;
    },
  };
  return root;
}

interface Harness {
  roots: RootStub[];
  windowStub: { __beforeAfterInit?: boolean };
  /** Диспатчит зарегистрированные на document слушатели типа `type`
   *  (имитация повторного `astro:page-load`). */
  fire(type: string): void;
}

/**
 * Прогоняет скрипт компонента с `document.readyState: 'complete'` — ветка
 * «стартуем немедленно», initBeforeAfter отрабатывает синхронно внутри run().
 */
function run(roots: RootStub[]): Harness {
  const listeners = new Map<string, Array<() => void>>();

  const documentStub = {
    readyState: 'complete',
    addEventListener(type: string, fn: () => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    querySelectorAll(sel: string) {
      return sel === '[data-before-after]' ? roots : [];
    },
  };

  const windowStub: { __beforeAfterInit?: boolean } = {};

  const fn = new Function('document', 'window', readScript());
  fn(documentStub, windowStub);

  return {
    roots,
    windowStub,
    fire(type) {
      for (const l of [...(listeners.get(type) ?? [])]) l();
    },
  };
}

describe('BeforeAfter — привязка range → CSS-переменная', () => {
  it('input пишет --ba-pos на контейнер и обновляет aria-valuetext «N %»', () => {
    const root = makeRoot();
    const h = run([root]);

    expect(h.windowStub.__beforeAfterInit).toBe(true);
    expect(root.dataset.ready).toBe('1');
    expect(root.range.inputListeners).toHaveLength(1);

    root.range.value = '72';
    root.range.inputListeners[0]!();

    expect(root.vars['--ba-pos']).toBe('72%');
    expect(root.range.attrs['aria-valuetext']).toBe('72 %');

    // Крайние значения — без сюрпризов.
    root.range.value = '0';
    root.range.inputListeners[0]!();
    expect(root.vars['--ba-pos']).toBe('0%');
    expect(root.range.attrs['aria-valuetext']).toBe('0 %');
  });

  it('повторный astro:page-load следом за первичной загрузкой НЕ дублирует слушатель (data-ready)', () => {
    const root = makeRoot();
    const h = run([root]);

    expect(root.range.inputListeners).toHaveLength(1);

    // ClientRouter диспатчит astro:page-load и на первичной загрузке тоже —
    // initBeforeAfter вызывается второй раз для ТОГО ЖЕ узла. Без data-ready
    // одно движение слайдера писало бы переменную дважды, а после N навигаций
    // с возвратом — N раз.
    h.fire('astro:page-load');
    expect(root.range.inputListeners).toHaveLength(1);

    // «Свежий» узел новой страницы (без data-ready) на следующем page-load
    // привязывается штатно.
    const fresh = makeRoot();
    h.roots.push(fresh);
    h.fire('astro:page-load');
    expect(fresh.range.inputListeners).toHaveLength(1);
    expect(root.range.inputListeners).toHaveLength(1);
  });

  it('несколько экземпляров на странице: у каждого свой слушатель и своя переменная', () => {
    const a = makeRoot();
    const b = makeRoot();
    run([a, b]);

    expect(a.range.inputListeners).toHaveLength(1);
    expect(b.range.inputListeners).toHaveLength(1);

    b.range.value = '15';
    b.range.inputListeners[0]!();

    expect(b.vars['--ba-pos']).toBe('15%');
    expect(a.vars['--ba-pos']).toBeUndefined(); // соседний экземпляр не тронут
  });

  it('контейнер без range внутри пропускается без ошибки и без data-ready', () => {
    const broken = makeRoot();
    broken.querySelector = () => null;
    const ok = makeRoot();
    run([broken, ok]);

    expect(broken.dataset.ready).toBeUndefined();
    expect(ok.range.inputListeners).toHaveLength(1);
  });
});
