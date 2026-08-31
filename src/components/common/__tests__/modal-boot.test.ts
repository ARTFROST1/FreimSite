// @vitest-environment jsdom
/**
 * Boot-тест `Modal.astro`: гоняется НАСТОЯЩИЙ `<script>` компонента
 * (вытащен из .astro регэкспом — приём stacked-showcase-boot.test.ts /
 * yandex-map-boot.test.ts), но не в ручных стабах, а в jsdom — проверяется
 * реальная делегированная логика на настоящем DOM-дереве.
 *
 * jsdom знает интерфейс HTMLDialogElement (и рефлексию атрибута `open`), но
 * НЕ реализует showModal()/close() — тесту хватает минимального полифила
 * ниже: showModal ставит `open`, close снимает его и диспатчит невсплывающее
 * событие `close` (как в спеке) — ровно те три вещи, на которые опирается
 * скрипт компонента.
 *
 * Проверяется контракт компонента:
 *   • открытие по клику на [data-modal-open="<id>"] (делегирование на document);
 *   • программное открытие через CustomEvent `app:modal-open`;
 *   • закрытие по [data-modal-close] внутри модалки и по клику на backdrop
 *     (target === сам <dialog>);
 *   • скролл-лок: body.style.overflow='hidden' пока открыт хотя бы один
 *     dialog, снимается только когда закрыт ПОСЛЕДНИЙ;
 *   • битый id триггера — тихо, без throw (CMS-превью не должно падать);
 *   • повторный прогон скрипта (флаг window.__modalInit) не дублирует
 *     обработчики — один клик открывает/закрывает ровно один раз.
 *
 * Скрипт компонента — TypeScript; типы снимает `ts.transpileModule` (НЕ
 * esbuild, как в stacked-showcase-boot: тот тест живёт в node-окружении, а
 * здесь jsdom, и esbuild падает на своём realm-инварианте
 * `TextEncoder().encode() instanceof Uint8Array`). `import.meta.env.DEV`
 * внутри `new Function` — синтаксическая ошибка (import.meta допустим только
 * в модулях), поэтому подменяется литералом до транспиляции (в реальной
 * сборке это делает Vite).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import ts from 'typescript';

// Не `fileURLToPath(new URL(..., import.meta.url))`, как в node-окруженных
// boot-тестах: под jsdom import.meta.url — не file:-URL, fileURLToPath
// падает. vitest всегда запускается из корня проекта (там vitest.config.ts).
const COMPONENT = join(process.cwd(), 'src/components/common/Modal.astro');

/** Тело единственного `<script>` компонента: JS после снятия типов. */
function readScript(): string {
  const src = readFileSync(COMPONENT, 'utf8');
  const match = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('в Modal.astro не найден <script>');
  const body = match[1].replaceAll('import.meta.env.DEV', 'false');
  return ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

/** Прогоняет скрипт компонента против текущего jsdom-документа. */
function boot(): void {
  const fn = new Function('window', 'document', readScript());
  fn(window, document);
}

/** Разметка страницы: два триггера, две модалки (упрощённый выхлоп Modal.astro). */
function renderPage(): void {
  document.body.innerHTML = `
    <button data-modal-open="m1">Открыть №1</button>
    <button data-modal-open="m2">Открыть №2</button>
    <button data-modal-open="ghost">Открыть несуществующую</button>

    <dialog id="m1" class="app-modal" data-modal aria-labelledby="m1-title">
      <div class="modal-panel">
        <button type="button" class="modal-close" data-modal-close aria-label="Закрыть">×</button>
        <h2 id="m1-title" data-modal-title tabindex="-1">Первая</h2>
        <p>Контент</p>
      </div>
    </dialog>

    <dialog id="m2" class="app-modal" data-modal aria-label="Диалоговое окно">
      <div class="modal-panel">
        <button type="button" class="modal-close" data-modal-close aria-label="Закрыть">×</button>
        <p>Без заголовка</p>
      </div>
    </dialog>
  `;
  document.body.style.overflow = '';
}

// ── Полифил <dialog> для jsdom (см. doc-комментарий файла) ──
const dialogProto = window.HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal: () => void;
  close: () => void;
};
if (typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function (this: HTMLDialogElement) {
    if (this.open) throw new DOMException('open уже стоит', 'InvalidStateError');
    this.setAttribute('open', '');
  };
  dialogProto.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    // как в спеке: close не всплывает — компонент ловит его capture-фазой
    this.dispatchEvent(new Event('close'));
  };
}

function dialog(id: string): HTMLDialogElement {
  return document.getElementById(id) as HTMLDialogElement;
}

function clickTrigger(id: string): void {
  document
    .querySelector<HTMLElement>(`[data-modal-open="${id}"]`)!
    .click();
}

// Документ в jsdom-окружении один на файл — как и в реальном сайте с
// ClientRouter. boot() зовётся в каждом тесте (см. последний кейс про
// идемпотентность), а флаг __modalInit гарантирует один набор слушателей.
beforeEach(() => {
  renderPage();
  boot();
});

describe('Modal — boot-скрипт', () => {
  it('клик по [data-modal-open] открывает модалку и ставит скролл-лок', () => {
    expect(dialog('m1').open).toBe(false);
    expect(document.body.style.overflow).toBe('');

    clickTrigger('m1');

    expect(dialog('m1').open).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    // фокус ушёл на заголовок (паттерн accessible-astro)
    expect(document.activeElement?.id).toBe('m1-title');
  });

  it('клик по [data-modal-close] закрывает модалку и снимает скролл-лок', () => {
    clickTrigger('m1');
    expect(dialog('m1').open).toBe(true);

    dialog('m1').querySelector<HTMLElement>('[data-modal-close]')!.click();

    expect(dialog('m1').open).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('клик по backdrop (target === <dialog>) закрывает модалку', () => {
    clickTrigger('m1');
    expect(dialog('m1').open).toBe(true);

    dialog('m1').click(); // клик по ::backdrop приходит с target = сам dialog

    expect(dialog('m1').open).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('CustomEvent app:modal-open открывает модалку программно', () => {
    document.dispatchEvent(new CustomEvent('app:modal-open', { detail: { id: 'm2' } }));

    expect(dialog('m2').open).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('скролл-лок снимается только с закрытием ПОСЛЕДНЕГО открытого диалога', () => {
    clickTrigger('m1');
    clickTrigger('m2'); // второй поверх первого
    expect(dialog('m1').open).toBe(true);
    expect(dialog('m2').open).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');

    dialog('m2').querySelector<HTMLElement>('[data-modal-close]')!.click();
    expect(dialog('m2').open).toBe(false);
    expect(document.body.style.overflow).toBe('hidden'); // m1 ещё открыта

    dialog('m1').querySelector<HTMLElement>('[data-modal-close]')!.click();
    expect(document.body.style.overflow).toBe('');
  });

  it('триггер на несуществующий id — тихо, без исключений', () => {
    expect(() => clickTrigger('ghost')).not.toThrow();
    expect(document.body.style.overflow).toBe('');
  });

  it('повторный boot (флаг __modalInit) не дублирует обработчики', () => {
    // beforeEach уже загрузил скрипт как минимум дважды к этому тесту, но
    // проверим явно: ещё два прогона — и одиночный клик всё равно даёт
    // консистентное open→close (задублированный обработчик закрыл бы модалку
    // тем же кликом, которым открыл, или уронил бы double-close).
    boot();
    boot();

    clickTrigger('m1');
    expect(dialog('m1').open).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');

    dialog('m1').querySelector<HTMLElement>('[data-modal-close]')!.click();
    expect(dialog('m1').open).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });
});
