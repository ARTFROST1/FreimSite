// @vitest-environment jsdom
/**
 * Регрессия на ПОВЕДЕНИЕ Dropdown.astro: открытие, Escape (с возвратом
 * фокуса на кнопку), клик-вне, цель аналитики, клавиатура.
 *
 * Тест гоняет НАСТОЯЩИЙ `<script>` компонента (вытащен из .astro) — тот же
 * приём, что stacked-showcase-boot.test.ts, но в jsdom: дропдауну нужны
 * настоящие focus/activeElement, closest и bubbling событий, стабать их
 * руками дороже, чем взять jsdom (он прямой devDep, уже используется
 * lead-form-тестами). `import { computePosition }`
 * вырезается и инжектится параметром — настоящей функцией из
 * src/lib/positioning.ts (в jsdom все замеры нулевые, координаты сведутся
 * к padding — для боевой логики открытия/закрытия это неважно).
 * Типы снимает `ts.transpileModule` (esbuild под jsdom не стартует).
 *
 * Скрипт исполняется ОДИН раз на файл (как в браузере — бандл-модуль живёт
 * одну сессию), между тестами состояние сбрасывается штатным же путём:
 * astro:before-swap закрывает открытое меню, новый DOM инициализируется
 * повторным astro:page-load.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { computePosition } from '../../../lib/positioning';

// Не esbuild и не `new URL(..., import.meta.url)`: под jsdom esbuild падает на
// invariant `TextEncoder().encode('') instanceof Uint8Array` (другой realm),
// а import.meta.url — не file:-URL. Тот же приём, что tabs-boot.test.ts.
const COMPONENT = join(process.cwd(), 'src/components/ui/Dropdown.astro');

/** Тело `<script>` компонента: без import-строк (инжектятся параметром), JS после снятия типов. */
function readScript(): string {
  const src = readFileSync(COMPONENT, 'utf8');
  const match = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('в Dropdown.astro не найден <script>');
  const withoutImports = match[1].replace(/^\s*import .*$/gm, '');
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

/** Разметка — как её рендерит Dropdown.astro (без scoped-атрибутов Astro). */
const FIXTURE = `
  <div class="dd" data-dd>
    <button type="button" class="dd-btn" aria-haspopup="menu" aria-expanded="false">Меню</button>
    <div class="dd-menu" role="menu" hidden>
      <a class="dd-item" role="menuitem" tabindex="-1" href="/catalog/">Каталог</a>
      <button class="dd-item" type="button" role="menuitem" tabindex="-1" data-goal="dd_goal">Заказать звонок</button>
      <a class="dd-item" role="menuitem" tabindex="-1" href="/contacts/">Контакты</a>
    </div>
  </div>
  <button id="outside" type="button">вне меню</button>
`;

const btn = () => document.querySelector<HTMLButtonElement>('.dd-btn')!;
const menu = () => document.querySelector<HTMLElement>('.dd-menu')!;
const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

const escape = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

/** Дождаться таймера анимации закрытия (ANIM_MS = 130 в компоненте). */
const settled = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeEach(() => {
  bootOnce();
  // Штатный сброс между «страницами»: закрывает меню прошлого теста,
  // пока его узлы (и placeholder портала) ещё в документе.
  document.dispatchEvent(new Event('astro:before-swap'));
  document.body.innerHTML = FIXTURE;
  document.dispatchEvent(new Event('astro:page-load'));
});

describe('Dropdown — открытие', () => {
  it('клик по кнопке открывает меню: aria-expanded, hidden снят, портал в <body>', () => {
    expect(menu().hidden).toBe(true);
    btn().click();

    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(menu().hidden).toBe(false);
    // Меню на время показа — прямой потомок <body> (fixed-координаты честны только там).
    expect(menu().parentElement).toBe(document.body);
  });

  it('astro:page-load связал кнопку и меню через aria-controls/aria-labelledby', () => {
    expect(menu().id).toBeTruthy();
    expect(btn().getAttribute('aria-controls')).toBe(menu().id);
    expect(menu().getAttribute('aria-labelledby')).toBe(btn().id);
  });

  it('повторный клик по кнопке закрывает меню и возвращает его на место', async () => {
    btn().click();
    btn().click();

    expect(btn().getAttribute('aria-expanded')).toBe('false');
    await settled();
    expect(menu().hidden).toBe(true);
    expect(menu().parentElement).not.toBe(document.body); // распорталено обратно
    expect(menu().closest('[data-dd]')).not.toBeNull();
  });
});

describe('Dropdown — Escape', () => {
  it('закрывает меню и возвращает фокус на кнопку', async () => {
    btn().click();
    escape();

    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn());
    await settled();
    expect(menu().hidden).toBe(true);
  });

  it('без открытого меню Escape ничего не трогает', () => {
    escape();
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(menu().hidden).toBe(true);
  });
});

describe('Dropdown — клик-вне', () => {
  it('клик вне кнопки и меню закрывает его (фокус не дёргается)', async () => {
    btn().click();
    document.getElementById('outside')!.click();

    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).not.toBe(btn());
    await settled();
    expect(menu().hidden).toBe(true);
  });

  it('клик ПО открытому меню (мимо пунктов) его не закрывает', () => {
    btn().click();
    menu().click();
    expect(btn().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Dropdown — два экземпляра, гонка exit-анимации', () => {
  const SECOND = `
    <div class="dd" data-dd id="dd2">
      <button type="button" class="dd-btn" aria-haspopup="menu" aria-expanded="false">Второе</button>
      <div class="dd-menu" role="menu" hidden>
        <a class="dd-item" role="menuitem" tabindex="-1" href="/about/">О нас</a>
      </div>
    </div>`;

  /** Все комментарии-закладки портала в документе. */
  const placeholders = (): Comment[] => {
    const out: Comment[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue === 'dd-placeholder') out.push(n as Comment);
    }
    return out;
  };

  it('клик-вне → в течение анимации клик по другому дропдауну: старое меню вернулось на место, «призрака» в body нет', async () => {
    document.body.insertAdjacentHTML('beforeend', SECOND);
    document.dispatchEvent(new Event('astro:page-load'));
    const root1 = document.querySelector<HTMLElement>('[data-dd]:not(#dd2)')!;
    const menu1 = root1.querySelector<HTMLElement>('.dd-menu')!;
    const root2 = document.getElementById('dd2')!;
    const btn2 = root2.querySelector<HTMLButtonElement>('.dd-btn')!;
    const menu2 = root2.querySelector<HTMLElement>('.dd-menu')!;

    btn().click(); // открыли первое
    expect(menu1.parentElement).toBe(document.body);
    document.getElementById('outside')!.click(); // закрываем — пошла exit-анимация
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(menu1.parentElement).toBe(document.body); // ещё доигрывает

    btn2.click(); // НЕ дожидаясь таймера — открываем второе

    // Старое меню добито синхронно: спрятано и распорталено обратно в свой корень.
    expect(menu1.hidden).toBe(true);
    expect(menu1.parentElement).toBe(root1);
    // В body — ровно одно портализованное меню (второе), закладка — ровно одна (его).
    expect(document.querySelectorAll('body > .dd-menu')).toHaveLength(1);
    expect(menu2.parentElement).toBe(document.body);
    expect(placeholders()).toHaveLength(1);
    expect(placeholders()[0]!.parentNode).toBe(root2);

    // И после истечения таймера старого закрытия ничего не ломается.
    await settled();
    expect(menu1.parentElement).toBe(root1);
    expect(menu2.parentElement).toBe(document.body);
    expect(btn2.getAttribute('aria-expanded')).toBe('true');
  });

  it('повторный клик по той же кнопке во время exit-анимации переоткрывает меню без дубля закладки', async () => {
    btn().click();
    btn().click(); // закрытие, анимация
    btn().click(); // переоткрытие до истечения таймера

    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(menu().parentElement).toBe(document.body);
    expect(placeholders()).toHaveLength(1);

    await settled(); // старый таймер обезврежен — меню не спряталось
    expect(menu().hidden).toBe(false);
    expect(menu().parentElement).toBe(document.body);
  });
});

describe('Dropdown — пункты и цель аналитики', () => {
  it('клик по пункту с data-goal шлёт window.trackConversion(goal) и закрывает меню', () => {
    const track = vi.fn();
    (window as any).trackConversion = track;
    try {
      btn().click();
      document.querySelector<HTMLElement>('[data-goal="dd_goal"]')!.click();

      expect(track).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenCalledWith('dd_goal');
      expect(btn().getAttribute('aria-expanded')).toBe('false');
    } finally {
      delete (window as any).trackConversion;
    }
  });

  it('упавший trackConversion не ломает закрытие меню', () => {
    (window as any).trackConversion = () => {
      throw new Error('метрика упала');
    };
    try {
      btn().click();
      expect(() =>
        document.querySelector<HTMLElement>('[data-goal="dd_goal"]')!.click(),
      ).not.toThrow();
      expect(btn().getAttribute('aria-expanded')).toBe('false');
    } finally {
      delete (window as any).trackConversion;
    }
  });
});

describe('Dropdown — клавиатура', () => {
  const keyOn = (el: HTMLElement, key: string) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('ArrowDown на кнопке открывает меню и фокусирует первый пункт', () => {
    btn().focus();
    keyOn(btn(), 'ArrowDown');

    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(items()[0]);
  });

  it('ArrowUp на кнопке открывает меню с фокусом на последнем пункте', () => {
    btn().focus();
    keyOn(btn(), 'ArrowUp');
    expect(document.activeElement).toBe(items()[2]);
  });

  it('стрелки ходят по пунктам по кругу, Home/End — в начало/конец', () => {
    btn().focus();
    keyOn(btn(), 'ArrowDown'); // фокус: пункт 0

    keyOn(items()[0], 'ArrowDown');
    expect(document.activeElement).toBe(items()[1]);

    keyOn(items()[1], 'End');
    expect(document.activeElement).toBe(items()[2]);

    keyOn(items()[2], 'ArrowDown'); // заворот вниз
    expect(document.activeElement).toBe(items()[0]);

    keyOn(items()[0], 'ArrowUp'); // заворот вверх
    expect(document.activeElement).toBe(items()[2]);

    keyOn(items()[2], 'Home');
    expect(document.activeElement).toBe(items()[0]);
  });
});
