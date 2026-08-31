// @vitest-environment jsdom
/**
 * Регрессия на поведение `Tabs.astro` (APG-табы).
 *
 * Тест гоняет НАСТОЯЩИЙ `<script>` компонента (вытащен из .astro — тот же
 * приём, что `stacked-showcase-boot.test.ts` / `yandex-map-boot.test.ts`),
 * но в jsdom, а не в ручном стабе: табы — это делегированные click/keydown
 * на document, roving tabindex и `hidden` на панелях, руками такой DOM
 * стабить дороже, чем взять готовый (jsdom — прямая dev-зависимость,
 * `lead-form-*.test.ts` уже работают так же).
 *
 * Разметка-фикстура повторяет серверный вывод компонента; контракт между
 * фикстурой и шаблоном стережёт отдельный блок «серверная разметка» ниже —
 * он читает сам .astro и проверяет, что панель по-прежнему рендерится с
 * `tabindex="0"` и скрывается атрибутом `hidden` (не aria-hidden/display).
 *
 * Скрипт компонента — TypeScript; типы снимает `ts.transpileModule`.
 * НЕ esbuild, как в stacked-showcase-boot.test.ts: esbuild проверяет
 * `new TextEncoder().encode('') instanceof Uint8Array`, а под jsdom-средой
 * это ложь (Uint8Array другого realm) — esbuild отказывается стартовать.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import ts from 'typescript';

// Не `new URL(..., import.meta.url)`, как в соседних boot-тестах: под
// jsdom-средой import.meta.url — не file:-URL, fileURLToPath падает.
// vitest всегда запускается из корня проекта (там vitest.config.ts).
const COMPONENT = join(process.cwd(), 'src/components/ui/Tabs.astro');
const SOURCE = readFileSync(COMPONENT, 'utf8');

/** Тело единственного `<script>` компонента, JS после снятия типов. */
function readScript(): string {
  const match = SOURCE.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('в Tabs.astro не найден <script>');
  return ts.transpileModule(match[1], {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText;
}

// Скрипт исполняется ОДИН раз на файл — как в браузере (Astro дедуплицирует
// бандл-скрипт). Все слушатели делегированы на document и читают DOM заново,
// поэтому каждому тесту достаточно подменить body и дёрнуть astro:page-load.
new Function(readScript())();

/** Серверный вывод одного экземпляра `<Tabs>` (зеркало шаблона компонента). */
function instance(
  uid: string,
  opts: { syncKey?: string; active?: string; ids?: string[] } = {},
): string {
  const ids = opts.ids ?? ['one', 'two', 'three'];
  const active = opts.active ?? ids[0];
  const sync = opts.syncKey ? ` data-tabs-sync="${opts.syncKey}"` : '';
  const buttons = ids
    .map(
      (id) => `<button type="button" id="${uid}-tab-${id}" class="tabs-tab" role="tab"
        aria-selected="${id === active ? 'true' : 'false'}"
        aria-controls="${uid}-panel-${id}" tabindex="${id === active ? '0' : '-1'}"
        data-tabs-value="${id}">${id}</button>`,
    )
    .join('');
  const panels = ids
    .map(
      (id) => `<div id="${uid}-panel-${id}" class="tabs-panel" role="tabpanel"
        aria-labelledby="${uid}-tab-${id}" tabindex="0"${id === active ? '' : ' hidden'}>
        <p>panel ${id}</p></div>`,
    )
    .join('');
  return `<div class="tabs" data-tabs${sync}>
    <div class="tabs-list" role="tablist" aria-label="Вкладки">${buttons}</div>
    ${panels}
  </div>`;
}

function pageLoad(): void {
  document.dispatchEvent(new Event('astro:page-load'));
}

function tab(uid: string, id: string): HTMLButtonElement {
  return document.getElementById(`${uid}-tab-${id}`) as HTMLButtonElement;
}

function panel(uid: string, id: string): HTMLElement {
  return document.getElementById(`${uid}-panel-${id}`) as HTMLElement;
}

function key(el: HTMLElement, k: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

/** Снимок состояния экземпляра: какая вкладка выбрана, какие панели скрыты. */
function state(uid: string, ids = ['one', 'two', 'three']) {
  return {
    selected: ids.filter((id) => tab(uid, id).getAttribute('aria-selected') === 'true'),
    tabbable: ids.filter((id) => tab(uid, id).getAttribute('tabindex') === '0'),
    hidden: ids.filter((id) => panel(uid, id).hidden),
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('Tabs — инициализация', () => {
  it('astro:page-load помечает экземпляр data-tabs-ready, серверное состояние не трогается', () => {
    document.body.innerHTML = instance('a');
    pageLoad();

    expect(document.querySelector('[data-tabs]')!.getAttribute('data-tabs-ready')).toBe('1');
    expect(state('a')).toEqual({ selected: ['one'], tabbable: ['one'], hidden: ['two', 'three'] });
  });
});

describe('Tabs — переключение кликом', () => {
  it('клик по вкладке: aria-selected + roving tabindex + hidden на панелях', () => {
    document.body.innerHTML = instance('a');
    pageLoad();

    tab('a', 'two').click();

    expect(state('a')).toEqual({ selected: ['two'], tabbable: ['two'], hidden: ['one', 'three'] });
  });

  it('панели скрываются именно атрибутом hidden — скрипт не пишет aria-hidden', () => {
    document.body.innerHTML = instance('a');
    pageLoad();

    tab('a', 'three').click();

    expect(panel('a', 'one').hasAttribute('hidden')).toBe(true);
    expect(panel('a', 'three').hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('[role="tabpanel"][aria-hidden]')).toBeNull();
  });
});

describe('Tabs — клавиатура (APG, автоматическая активация)', () => {
  it('ArrowRight: следующая вкладка активируется и получает фокус; с последней — закольцовывание на первую', () => {
    document.body.innerHTML = instance('a');
    pageLoad();

    key(tab('a', 'one'), 'ArrowRight');
    expect(state('a').selected).toEqual(['two']);
    expect(document.activeElement).toBe(tab('a', 'two'));

    key(tab('a', 'two'), 'ArrowRight');
    key(tab('a', 'three'), 'ArrowRight'); // с последней — на первую
    expect(state('a')).toEqual({ selected: ['one'], tabbable: ['one'], hidden: ['two', 'three'] });
    expect(document.activeElement).toBe(tab('a', 'one'));
  });

  it('ArrowLeft с первой вкладки закольцовывается на последнюю', () => {
    document.body.innerHTML = instance('a');
    pageLoad();

    key(tab('a', 'one'), 'ArrowLeft');

    expect(state('a')).toEqual({ selected: ['three'], tabbable: ['three'], hidden: ['one', 'two'] });
    expect(document.activeElement).toBe(tab('a', 'three'));
  });

  it('Home/End прыгают на первую/последнюю вкладку', () => {
    document.body.innerHTML = instance('a', { active: 'two' });
    pageLoad();

    key(tab('a', 'two'), 'End');
    expect(state('a').selected).toEqual(['three']);
    expect(document.activeElement).toBe(tab('a', 'three'));

    key(tab('a', 'three'), 'Home');
    expect(state('a')).toEqual({ selected: ['one'], tabbable: ['one'], hidden: ['two', 'three'] });
  });

  it('посторонние клавиши не трогают состояние и не гасятся', () => {
    document.body.innerHTML = instance('a');
    pageLoad();

    key(tab('a', 'one'), 'ArrowDown');

    expect(state('a').selected).toEqual(['one']);
  });
});

describe('Tabs — syncKey', () => {
  it('клик в одном экземпляре переключает близнеца и пишет выбор в localStorage', () => {
    document.body.innerHTML =
      instance('a', { syncKey: 'demo' }) + instance('b', { syncKey: 'demo' });
    pageLoad();

    tab('a', 'two').click();

    expect(state('b')).toEqual({ selected: ['two'], tabbable: ['two'], hidden: ['one', 'three'] });
    expect(localStorage.getItem('tabs-sync:demo')).toBe('two');
  });

  it('экземпляры с ДРУГИМ syncKey (и без него) не затрагиваются', () => {
    document.body.innerHTML =
      instance('a', { syncKey: 'demo' }) + instance('b', { syncKey: 'other' }) + instance('c');
    pageLoad();

    tab('a', 'three').click();

    expect(state('b').selected).toEqual(['one']);
    expect(state('c').selected).toEqual(['one']);
  });

  it('на astro:page-load сохранённый выбор применяется к свежему экземпляру', () => {
    localStorage.setItem('tabs-sync:demo', 'three');
    document.body.innerHTML = instance('a', { syncKey: 'demo' });

    pageLoad(); // «пришла новая страница» — выбор восстановлен из localStorage

    expect(state('a')).toEqual({ selected: ['three'], tabbable: ['three'], hidden: ['one', 'two'] });
  });
});

describe('Tabs — контракт серверной разметки (фикстура выше зеркалит шаблон)', () => {
  it('панель рендерится с tabindex="0" и скрывается атрибутом hidden', () => {
    // role="tabpanel" в шаблоне соседствует с tabindex="0" и hidden={…}.
    const panelTag = SOURCE.match(/<div\s[^>]*role="tabpanel"[\s\S]*?>/)?.[0] ?? '';
    expect(panelTag).toContain('tabindex="0"');
    expect(panelTag).toMatch(/hidden=\{/);
    // Именно атрибут/сеттер, не упоминание в doc-comment.
    expect(SOURCE).not.toMatch(/aria-hidden[='"]/);
  });

  it('вкладка — button с ролью tab, ARIA-связками и roving tabindex', () => {
    const tabTag = SOURCE.match(/<button\s[\s\S]*?role="tab"[\s\S]*?>/)?.[0] ?? '';
    expect(tabTag).toContain('aria-selected=');
    expect(tabTag).toContain('aria-controls=');
    expect(tabTag).toContain('data-tabs-value=');
    expect(tabTag).toMatch(/tabindex=\{/);
    expect(SOURCE).toContain('role="tablist"');
  });

  it('префикс DOM-id детерминирован: без Math.random, с явным пропом id', () => {
    // Случайный uid = разный HTML от сборки к сборке (диффы, кэш, снапшоты).
    expect(SOURCE).not.toContain('Math.random');
    expect(SOURCE).toMatch(/\bid\?: string;/);
    expect(SOURCE).toMatch(/const uid =\s*id \?\?/);
  });
});
