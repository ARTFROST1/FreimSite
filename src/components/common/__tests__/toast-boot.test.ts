// @vitest-environment jsdom
/**
 * Регрессия на клиентский скрипт `Toast.astro`: window.toast / app:toast
 * создают тосты, maxToasts вытесняет старые, dismissAll и Escape чистят всё,
 * hover ставит авто-скрытие на паузу, отсутствие контейнера — no-op.
 *
 * Тест гоняет НАСТОЯЩИЙ `<script>` компонента (вытащен из .astro) — тот же
 * приём, что `stacked-showcase-boot.test.ts`, но на jsdom вместо ручных
 * стабов: скрипт живёт клонированием `<template>` и querySelectorAll, ручной
 * стаб такого DOM был бы толще самого скрипта. Разметка контейнера ниже —
 * зеркало серверной части компонента; от дрейфа селекторов страхует
 * отдельный тест по исходнику .astro.
 *
 * Скрипт — TypeScript. stacked-showcase-boot снимает типы esbuild'ом, но под
 * jsdom-окружением esbuild не заводится (jsdom подменяет Uint8Array, esbuild
 * падает на своём инварианте) — поэтому здесь `ts.transpileModule` с эмитом
 * в CommonJS: модульный `export {}`, который в `new Function` был бы
 * синтаксической ошибкой, превращается в безобидную запись в стаб `exports`.
 * `import.meta.env.DEV` (тоже нелегальный вне модуля) заменяется на `true`
 * ДО транспиляции — заодно проверяется dev-ветка с console.warn.
 *
 * `window` внутри скрипта — это globalThis теста: fake-таймеры vitest
 * патчат именно globalThis, и `window.setTimeout` скрипта обязан попадать
 * в них, а не в реальные таймеры jsdom-окна.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

// Не через `new URL(import.meta.url)`, как в stacked-showcase-boot: под
// jsdom-окружением import.meta.url — это http://…, не file://. Корень
// процесса vitest — корень репозитория (там vitest.config.ts).
const COMPONENT = resolve(process.cwd(), 'src/components/common/Toast.astro');

function readScript(): string {
  const src = readFileSync(COMPONENT, 'utf8');
  const match = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('в Toast.astro не найден <script>');
  const body = match[1]!.replace(/import\.meta\.env\.DEV/g, 'true');
  return ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

/** Зеркало серверной разметки контейнера из Toast.astro. */
function mountRegion(opts: { duration?: number; maxToasts?: number } = {}): void {
  const { duration = 5000, maxToasts = 3 } = opts;
  document.body.innerHTML = `
    <div class="toast-region" role="log" aria-label="Уведомления"
         data-toast-region data-duration="${duration}" data-max-toasts="${maxToasts}">
      <template data-toast-template>
        <div class="toast" data-toast-item data-type="info">
          <span class="toast-bar" aria-hidden="true"></span>
          <p class="toast-text">
            <span class="sr-only" data-toast-sr></span>
            <span data-toast-message></span>
          </p>
          <button type="button" class="toast-close" data-toast-dismiss
                  aria-label="Закрыть уведомление">×</button>
        </div>
      </template>
    </div>`;
}

type ToastApi = {
  show(message: string, options?: { type?: string; duration?: number }): string;
  success(message: string, duration?: number): string;
  error(message: string, duration?: number): string;
  info(message: string, duration?: number): string;
  dismissAll(): void;
};

function api(): ToastApi {
  const t = (globalThis as { toast?: ToastApi }).toast;
  if (!t) throw new Error('window.toast не установлен скриптом компонента');
  return t;
}

function items(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-toast-item]'));
}

beforeAll(() => {
  // Один прогон на файл: скрипт сам ставит window.__toastInit и не даст
  // навесить синглтоны второй раз — как в реальном приложении.
  new Function('window', 'document', 'exports', readScript())(globalThis, document, {});
});

beforeEach(() => {
  vi.useFakeTimers();
  mountRegion();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
});

describe('Toast — window.toast API', () => {
  it('show() создаёт тост: сообщение, тип полоской (data-type) и sr-only префиксом', () => {
    const id = api().show('Заявка отправлена', { type: 'success' });

    expect(id).toMatch(/^toast-\d+$/);
    const toasts = items();
    expect(toasts).toHaveLength(1);
    const toast = toasts[0]!;
    expect(toast.dataset.toastId).toBe(id);
    expect(toast.dataset.type).toBe('success');
    expect(toast.querySelector('[data-toast-message]')!.textContent).toBe('Заявка отправлена');
    expect(toast.querySelector('[data-toast-sr]')!.textContent).toBe('Успех:');
  });

  it('шорткаты success/error/info проставляют тип; неизвестный тип падает в info', () => {
    // Ровно maxToasts (3) штук — четвёртый вытеснил бы первый (это
    // проверяет соседний тест), а здесь проверяем маппинг типов.
    api().success('ок');
    api().error('плохо');
    api().show('загадка', { type: 'party' });

    expect(items().map((t) => t.dataset.type)).toEqual(['success', 'error', 'info']);
    expect(items().map((t) => t.querySelector('[data-toast-sr]')!.textContent)).toEqual([
      'Успех:',
      'Ошибка:',
      'Инфо:',
    ]);
  });

  it('sr-only префиксы переопределяются пропами через data-label-* на контейнере', () => {
    const region = document.querySelector<HTMLElement>('[data-toast-region]')!;
    region.dataset.labelSuccess = 'Success:';
    region.dataset.labelError = 'Error:';
    region.dataset.labelInfo = 'Info:';

    api().success('a');
    api().error('b');
    api().info('c');

    expect(items().map((t) => t.querySelector('[data-toast-sr]')!.textContent)).toEqual([
      'Success:',
      'Error:',
      'Info:',
    ]);
  });

  it('maxToasts: старейшие вытесняются мгновенно, остаются последние N', () => {
    api().info('первый');
    api().info('второй');
    api().info('третий');
    expect(items()).toHaveLength(3);

    api().info('четвёртый');

    const texts = items().map((t) => t.querySelector('[data-toast-message]')!.textContent);
    expect(texts).toEqual(['второй', 'третий', 'четвёртый']);
  });

  it('dismissAll() убирает все тосты (leaving → удаление по таймауту-страховке)', () => {
    api().success('раз');
    api().error('два');
    expect(items()).toHaveLength(2);

    api().dismissAll();

    // Без reduced-motion удаление анимированное: сначала состояние leaving…
    expect(items().map((t) => t.dataset.state)).toEqual(['leaving', 'leaving']);
    // …затем страховочный setTimeout(300) добивает без transitionend (jsdom).
    vi.advanceTimersByTime(300);
    expect(items()).toHaveLength(0);
  });

  it('prefers-reduced-motion: reduce — удаление мгновенное, без leaving-фазы', () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: true });
    api().info('сразу исчезну');

    api().dismissAll();

    expect(items()).toHaveLength(0); // синхронно, никакого advanceTimers
  });
});

describe('Toast — жизненный цикл', () => {
  it('авто-скрытие по duration (пер-вызовный приоритетнее data-duration контейнера)', () => {
    api().show('быстрый', { duration: 1000 });

    vi.advanceTimersByTime(999);
    expect(items()).toHaveLength(1);
    vi.advanceTimersByTime(1 + 300); // дожил до дедлайна + страховка leaving
    expect(items()).toHaveLength(0);
  });

  it('hover ставит авто-скрытие на паузу, mouseleave — возобновляет остаток', () => {
    api().show('читаю', { duration: 1000 });
    const toast = items()[0]!;

    vi.advanceTimersByTime(400);
    toast.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(5000); // «завис» над тостом дольше любого duration
    expect(items()).toHaveLength(1); // всё ещё на месте

    toast.dispatchEvent(new Event('mouseleave'));
    vi.advanceTimersByTime(600 + 300); // остаток 600 мс + страховка leaving
    expect(items()).toHaveLength(0);
  });

  it('Escape закрывает все тосты', () => {
    api().info('раз');
    api().info('два');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    vi.advanceTimersByTime(300);

    expect(items()).toHaveLength(0);
  });
});

describe('Toast — путь через CustomEvent и деградация', () => {
  it('document.dispatchEvent(app:toast) создаёт тост без обращения к window.toast', () => {
    document.dispatchEvent(
      new CustomEvent('app:toast', { detail: { message: 'из события', type: 'error' } }),
    );

    const toasts = items();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.dataset.type).toBe('error');
    expect(toasts[0]!.querySelector('[data-toast-message]')!.textContent).toBe('из события');
  });

  it('app:toast с мусорным detail — no-op без исключений', () => {
    document.dispatchEvent(new CustomEvent('app:toast', { detail: null }));
    document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 42 } }));
    expect(items()).toHaveLength(0);
  });

  it('контейнер не смонтирован: show() — no-op с console.warn (dev), без исключений', () => {
    document.body.innerHTML = '';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(api().show('в пустоту')).toBe('');
    expect(warn).toHaveBeenCalledWith('[Toast]', expect.stringContaining('[data-toast-region]'));
  });
});

describe('Toast — контракт разметки компонента', () => {
  it('серверная разметка .astro несёт селекторы, на которые завязан скрипт и это зеркало', () => {
    const src = readFileSync(COMPONENT, 'utf8');
    // Разметка в mountRegion() выше — копия; если переименовали data-атрибут
    // в компоненте, этот тест падает раньше, чем ложно-зелёные зеркальные.
    for (const marker of [
      'data-toast-region',
      'data-toast-template',
      'data-toast-item',
      'data-toast-sr',
      'data-toast-message',
      'data-toast-dismiss',
      'role="log"',
    ]) {
      expect(src).toContain(marker);
    }
  });
});
