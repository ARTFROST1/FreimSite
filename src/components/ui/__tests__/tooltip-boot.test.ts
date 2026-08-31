// @vitest-environment jsdom
/**
 * Регрессия на ПОВЕДЕНИЕ Tooltip.astro: показ по focus, скрытие по
 * blur/Escape, портал в <body> и — главное — гонка exit-анимации: Tab с
 * одного триггера на соседний не должен оставлять в <body> «призрак»
 * предыдущего бабла (баг голого clearTimeout, см. pendingFinalize в
 * компоненте).
 *
 * Тест гоняет НАСТОЯЩИЙ `<script>` компонента (вытащен из .astro) в jsdom —
 * тот же приём, что dropdown-boot.test.ts / tabs-boot.test.ts. Импорт
 * `computePosition` вырезается и инжектится параметром (настоящая функция
 * из src/lib/positioning.ts; в jsdom все замеры нулевые — для логики
 * показа/скрытия это неважно). Типы снимает `ts.transpileModule` — НЕ
 * esbuild: под jsdom esbuild падает на своём realm-инварианте
 * `TextEncoder().encode('') instanceof Uint8Array`. Путь к компоненту —
 * через process.cwd(): под jsdom import.meta.url — не file:-URL.
 *
 * Скрипт исполняется ОДИН раз на файл (как в браузере), между тестами
 * состояние сбрасывается штатным путём: astro:before-swap прячет открытый
 * бабл, новый DOM инициализируется повторным astro:page-load.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { computePosition } from '../../../lib/positioning';

const COMPONENT = join(process.cwd(), 'src/components/ui/Tooltip.astro');

/** Тело `<script>` компонента: без import-строк (инжектятся параметром), JS после снятия типов. */
function readScript(): string {
  const src = readFileSync(COMPONENT, 'utf8');
  const match = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('в Tooltip.astro не найден <script>');
  const withoutImports = match[1]!.replace(/^\s*import .*$/gm, '');
  return ts.transpileModule(withoutImports, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText;
}

let booted = false;
function bootOnce() {
  if (booted) return;
  booted = true;
  const fn = new Function('window', 'document', 'computePosition', readScript());
  fn(window, document, computePosition);
}

/** Разметка — как её рендерит Tooltip.astro (без scoped-атрибутов Astro). */
const host = (id: string, text: string) => `
  <span class="tt-host" id="${id}" data-tt-placement="top" data-tt-delay="300">
    <button type="button" class="trigger">?</button>
    <span class="tt-bubble" role="tooltip" hidden>${text}</span>
  </span>`;

const FIXTURE = host('h1', 'Первая подсказка') + host('h2', 'Вторая подсказка') + `
  <button id="outside" type="button">вне</button>`;

const hostEl = (id: string) => document.getElementById(id) as HTMLElement;
const trigger = (id: string) => hostEl(id).querySelector<HTMLButtonElement>('.trigger')!;
const bubbleOf = (id: string) => document.getElementById(hostEl(id).dataset.bubbleId ?? '') as HTMLElement;
const bodyBubbles = () => Array.from(document.querySelectorAll<HTMLElement>('body > .tt-bubble'));

const focusIn = (el: HTMLElement) => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
const focusOut = (el: HTMLElement) => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
const escape = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

/** Дождаться таймера анимации закрытия (ANIM_MS = 160 в компоненте). */
const settled = () => new Promise((resolve) => setTimeout(resolve, 230));

/** Все комментарии-закладки портала в документе. */
function placeholders(): Comment[] {
  const out: Comment[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue === 'tt-placeholder') out.push(n as Comment);
  }
  return out;
}

beforeEach(() => {
  bootOnce();
  // Штатный сброс между «страницами»: прячет бабл прошлого теста, пока его
  // узлы (и placeholder портала) ещё в документе.
  document.dispatchEvent(new Event('astro:before-swap'));
  document.body.innerHTML = FIXTURE;
  document.dispatchEvent(new Event('astro:page-load'));
  // Запоминаем id баблов: после портала в <body> искать их через host нельзя.
  for (const id of ['h1', 'h2']) {
    hostEl(id).dataset.bubbleId = hostEl(id).querySelector<HTMLElement>('.tt-bubble')!.id;
  }
});

describe('Tooltip — инициализация', () => {
  it('astro:page-load связал триггер и бабл через aria-describedby', () => {
    expect(bubbleOf('h1').id).toBeTruthy();
    expect(trigger('h1').getAttribute('aria-describedby')).toBe(bubbleOf('h1').id);
    expect(bubbleOf('h1').hidden).toBe(true);
  });
});

describe('Tooltip — focus / blur / Escape', () => {
  it('focus на триггере показывает бабл сразу (без hover-задержки) и портализует его в <body>', () => {
    focusIn(trigger('h1'));

    expect(bubbleOf('h1').hidden).toBe(false);
    expect(bubbleOf('h1').parentElement).toBe(document.body);
    expect(placeholders()).toHaveLength(1);
    expect(placeholders()[0]!.parentNode).toBe(hostEl('h1'));
  });

  it('blur прячет бабл и возвращает его на место после анимации', async () => {
    focusIn(trigger('h1'));
    focusOut(trigger('h1'));

    await settled();
    expect(bubbleOf('h1').hidden).toBe(true);
    expect(bubbleOf('h1').parentElement).toBe(hostEl('h1'));
    expect(placeholders()).toHaveLength(0);
  });

  it('Escape прячет открытый бабл', async () => {
    focusIn(trigger('h1'));
    escape();

    await settled();
    expect(bubbleOf('h1').hidden).toBe(true);
    expect(bodyBubbles()).toHaveLength(0);
  });

  it('клик вне хоста и бабла прячет его', async () => {
    focusIn(trigger('h1'));
    document.getElementById('outside')!.click();

    await settled();
    expect(bubbleOf('h1').hidden).toBe(true);
  });
});

describe('Tooltip — гонка exit-анимации', () => {
  it('Tab с одного триггера на соседний: в <body> ровно один бабл, старый вернулся в хост', async () => {
    focusIn(trigger('h1'));
    focusOut(trigger('h1')); // пошла exit-анимация первого
    expect(bubbleOf('h1').parentElement).toBe(document.body);

    focusIn(trigger('h2')); // НЕ дожидаясь таймера

    // Старый бабл добит синхронно, новый — единственный в <body>.
    expect(bodyBubbles()).toHaveLength(1);
    expect(bodyBubbles()[0]).toBe(bubbleOf('h2'));
    expect(bubbleOf('h1').hidden).toBe(true);
    expect(bubbleOf('h1').parentElement).toBe(hostEl('h1'));
    expect(placeholders()).toHaveLength(1);
    expect(placeholders()[0]!.parentNode).toBe(hostEl('h2'));

    // Истёкший таймер старого закрытия ничего не ломает.
    await settled();
    expect(bodyBubbles()).toHaveLength(1);
    expect(bubbleOf('h2').hidden).toBe(false);
  });

  it('повторный focus на том же триггере во время exit-анимации переоткрывает бабл без дубля закладки', async () => {
    focusIn(trigger('h1'));
    focusOut(trigger('h1'));
    focusIn(trigger('h1'));

    expect(bubbleOf('h1').hidden).toBe(false);
    expect(bubbleOf('h1').parentElement).toBe(document.body);
    expect(placeholders()).toHaveLength(1);

    await settled(); // старый таймер обезврежен — бабл не спрятался
    expect(bubbleOf('h1').hidden).toBe(false);
    expect(bodyBubbles()).toHaveLength(1);
  });
});
