// @vitest-environment jsdom
/**
 * Регрессия на жизненный цикл `Carousel.astro` (CSS scroll-snap + ванильные
 * кнопки/точки, без Embla).
 *
 * Тест гоняет НАСТОЯЩИЙ `<script>` компонента (вытащен из .astro) — тот же
 * приём, что `stacked-showcase-boot.test.ts`: проверяется поведение, а не
 * наличие нужных слов в файле. Окружение — jsdom, но jsdom не считает layout
 * (scrollWidth/offsetLeft всегда 0) и не реализует `scrollTo`, поэтому
 * геометрия трека и слайдов мокается точечно через `Object.defineProperty`:
 * 3 слайда по 1000px, вьюпорт 1000px → maxScroll = 2000.
 *
 * Скрипт компонента — TypeScript (Astro транспилирует его при сборке); здесь
 * типы снимает `esbuild.transformSync`, иначе generic-вызовы
 * `querySelector<HTMLElement>(…)` распарсились бы как цепочки сравнений.
 *
 * Что стережём:
 *   1. инициализация: `is-ready` (показывает скрытые до JS кнопки), точки
 *      «Слайд N», состояние в data-атрибутах корня;
 *   2. клик next/точки → `scrollTo` координаты снапа (clamped на краю);
 *   3. sync из scroll-события (rAF замокан синхронным) — `disabled` на краях,
 *      `data-selected-index`, CustomEvent `carousel:select`;
 *   4. повторный `astro:page-load` не дублирует инстанс/точки, отвалившийся
 *      после «свапа» узел вычищается из store по `document.contains`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
// НЕ esbuild (как в stacked-showcase-boot.test.ts): esbuild при импорте
// проверяет `new TextEncoder().encode('') instanceof Uint8Array`, а под jsdom
// TextEncoder живёт в другом realm'е — инвариант ложен, esbuild отказывается
// стартовать. `ts.transpileModule` — чистый JS, realm'ов не боится.
import ts from 'typescript';

// НЕ `new URL(…, import.meta.url)` (паттерн stacked-showcase-boot.test.ts):
// под jsdom глобальный URL — из его realm'а, и fileURLToPath такой объект
// отвергает («The URL must be of scheme file»). Строковый путь — надёжнее.
const COMPONENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'Carousel.astro');

/** Тело единственного `<script>` компонента, JS после снятия типов. */
function readScript(): string {
  const src = readFileSync(COMPONENT, 'utf8');
  const match = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('в Carousel.astro не найден <script>');
  return ts.transpileModule(match[1]!, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

const SLIDE_W = 1000;
const VIEWPORT_W = 1000;

interface Mounted {
  root: HTMLElement;
  track: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  dotsWrap: HTMLElement;
  dots(): HTMLButtonElement[];
  scrollTo: Mock;
  /** Выставляет scrollLeft напрямую и диспатчит scroll (ручной свайп). */
  swipeTo(left: number): void;
}

/**
 * Собирает разметку карусели (та же схема data-атрибутов, что в .astro) и
 * мокает геометрию: jsdom layout не считает. Мок `scrollTo` двигает
 * scrollLeft и диспатчит scroll — как настоящий браузер.
 */
function mount(slideCount = 3): Mounted {
  document.body.innerHTML = `
    <div class="carousel" data-carousel>
      <div class="carousel-track" data-carousel-track role="region" aria-label="Карусель" tabindex="0">
        ${Array.from({ length: slideCount }, (_, i) => `<div class="slide">slide-${i + 1}</div>`).join('')}
      </div>
      <div class="carousel-footer">
        <div class="carousel-dots" data-carousel-dots></div>
        <div class="carousel-nav">
          <button type="button" data-carousel-prev aria-label="Назад" disabled></button>
          <button type="button" data-carousel-next aria-label="Вперёд" disabled></button>
        </div>
      </div>
    </div>`;

  const root = document.querySelector<HTMLElement>('[data-carousel]')!;
  const track = root.querySelector<HTMLElement>('[data-carousel-track]')!;

  let scrollLeft = 0;
  Object.defineProperty(track, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v;
    },
  });
  Object.defineProperty(track, 'scrollWidth', { configurable: true, get: () => slideCount * SLIDE_W });
  Object.defineProperty(track, 'clientWidth', { configurable: true, get: () => VIEWPORT_W });
  Array.from(track.children).forEach((slide, i) => {
    Object.defineProperty(slide, 'offsetLeft', { configurable: true, get: () => i * SLIDE_W });
  });

  const scrollTo = vi.fn((opts: { left: number }) => {
    scrollLeft = opts.left;
    track.dispatchEvent(new Event('scroll'));
  });
  // Сигнатура DOM `scrollTo` перегружена (options | x,y) — мок покрывает только
  // options-вариант, поэтому присваиваем через unknown.
  (track as unknown as { scrollTo: Mock }).scrollTo = scrollTo;

  return {
    root,
    track,
    prev: root.querySelector<HTMLButtonElement>('[data-carousel-prev]')!,
    next: root.querySelector<HTMLButtonElement>('[data-carousel-next]')!,
    dotsWrap: root.querySelector<HTMLElement>('[data-carousel-dots]')!,
    dots: () => Array.from(root.querySelectorAll<HTMLButtonElement>('.carousel-dot')),
    scrollTo,
    swipeTo(left: number) {
      scrollLeft = left;
      track.dispatchEvent(new Event('scroll'));
    },
  };
}

const script = readScript();

/**
 * Исполняет скрипт компонента (singleton-гард делает повторный прогон no-op)
 * и «будит» инициализацию как ClientRouter — событием astro:page-load.
 * На самом первом прогоне initAll() отрабатывает ещё и синхронно внутри
 * скрипта (readyState в jsdom — 'complete'); двойной вызов обязан быть
 * безопасен — это часть контракта, которую тест и проверяет.
 */
function boot(): void {
  new Function(script)();
  document.dispatchEvent(new Event('astro:page-load'));
}

const store = () => (window as unknown as { __carouselStore: Map<HTMLElement, unknown> }).__carouselStore;

beforeAll(() => {
  // sync() троттлится через rAF — в тесте кадр «наступает» синхронно.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Carousel — инициализация', () => {
  it('вешает is-ready (показывает контролы), создаёт точки, публикует состояние в data-атрибутах', () => {
    const c = mount(3);
    boot();

    expect(c.root.classList.contains('is-ready')).toBe(true);

    const dots = c.dots();
    expect(dots).toHaveLength(3);
    expect(dots.map((d) => d.getAttribute('aria-label'))).toEqual(['Слайд 1', 'Слайд 2', 'Слайд 3']);
    expect(dots[0]!.getAttribute('aria-current')).toBe('true');
    expect(dots[1]!.hasAttribute('aria-current')).toBe(false);

    // На левом краю: назад нельзя, вперёд можно.
    expect(c.prev.disabled).toBe(true);
    expect(c.next.disabled).toBe(false);
    expect(c.root.dataset.canScrollPrev).toBe('false');
    expect(c.root.dataset.canScrollNext).toBe('true');
    expect(c.root.dataset.selectedIndex).toBe('0');
  });
});

describe('Carousel — кнопки и точки', () => {
  it('клик next → scrollTo следующего снапа; состояние и точки обновляются из scroll-события', () => {
    const c = mount(3);
    boot();

    c.next.click();
    expect(c.scrollTo).toHaveBeenCalledWith({ left: SLIDE_W });
    expect(c.root.dataset.selectedIndex).toBe('1');
    expect(c.prev.disabled).toBe(false);
    expect(c.next.disabled).toBe(false);
    expect(c.dots()[1]!.getAttribute('aria-current')).toBe('true');
    expect(c.dots()[0]!.hasAttribute('aria-current')).toBe(false);

    // Второй клик — правый край: next гаснет, честный скролл без loop.
    c.next.click();
    expect(c.scrollTo).toHaveBeenLastCalledWith({ left: 2 * SLIDE_W });
    expect(c.root.dataset.selectedIndex).toBe('2');
    expect(c.next.disabled).toBe(true);
    expect(c.root.dataset.canScrollNext).toBe('false');
    expect(c.prev.disabled).toBe(false);

    // Клик по задизейбленной кнопке браузер не доставит, но даже прямой вызов
    // на краю клампится — координата не уезжает за maxScroll.
    c.next.click();
    expect(c.root.dataset.selectedIndex).toBe('2');
  });

  it('клик prev с правого края возвращает на предыдущий снап', () => {
    const c = mount(3);
    boot();
    c.swipeTo(2 * SLIDE_W);
    expect(c.root.dataset.selectedIndex).toBe('2');

    c.prev.click();
    expect(c.scrollTo).toHaveBeenLastCalledWith({ left: SLIDE_W });
    expect(c.root.dataset.selectedIndex).toBe('1');
  });

  it('клик по точке — scrollTo снапа её слайда', () => {
    const c = mount(3);
    boot();

    c.dots()[2]!.click();
    expect(c.scrollTo).toHaveBeenCalledWith({ left: 2 * SLIDE_W });
    expect(c.dots()[2]!.getAttribute('aria-current')).toBe('true');
    expect(c.root.dataset.selectedIndex).toBe('2');
  });

  it('стрелки ←/→ на треке листают по снапам', () => {
    const c = mount(3);
    boot();

    c.track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(c.scrollTo).toHaveBeenLastCalledWith({ left: SLIDE_W });
    c.track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(c.scrollTo).toHaveBeenLastCalledWith({ left: 0 });
  });
});

describe('Carousel — события', () => {
  it('carousel:select всплывает с индексом и флагами краёв', () => {
    const c = mount(3);
    boot();

    const seen: Array<{ index: number; canScrollPrev: boolean; canScrollNext: boolean; slideCount: number }> = [];
    c.root.addEventListener('carousel:select', (e) => {
      seen.push((e as CustomEvent).detail);
    });

    c.next.click();
    expect(seen.at(-1)).toEqual({ index: 1, canScrollPrev: true, canScrollNext: true, slideCount: 3 });

    c.swipeTo(2 * SLIDE_W);
    expect(seen.at(-1)).toEqual({ index: 2, canScrollPrev: true, canScrollNext: false, slideCount: 3 });
  });

  it('carousel:select не стреляет на каждый кадр скролла — только при смене индекса', () => {
    const c = mount(3);
    const seen: number[] = [];
    c.root.addEventListener('carousel:select', (e) => seen.push((e as CustomEvent).detail.index));
    boot();
    expect(seen).toEqual([0]); // один раз при init

    // Промежуточные кадры внутри того же снапа — тишина.
    c.swipeTo(100);
    c.swipeTo(300);
    expect(seen).toEqual([0]);
    // data-атрибуты при этом продолжают обновляться на каждый кадр.
    expect(c.root.dataset.canScrollPrev).toBe('true');

    c.swipeTo(SLIDE_W); // сменился индекс — одно событие
    c.swipeTo(SLIDE_W + 50);
    expect(seen).toEqual([0, 1]);
  });
});

describe('Carousel — dotLabel', () => {
  it('aria-label точек берётся из data-dot-label корня (проп dotLabel)', () => {
    const c = mount(2);
    c.root.dataset.dotLabel = 'Slide';
    boot();
    expect(c.dots().map((d) => d.getAttribute('aria-label'))).toEqual(['Slide 1', 'Slide 2']);
  });
});

describe('Carousel — жизненный цикл (SPA)', () => {
  it('повторный astro:page-load не дублирует инстанс и точки', () => {
    const c = mount(3);
    boot();
    expect(store().size).toBe(1);
    expect(c.dots()).toHaveLength(3);

    document.dispatchEvent(new Event('astro:page-load'));
    expect(store().size).toBe(1);
    expect(c.dots()).toHaveLength(3); // dotsWrap не переполнился вторым набором
  });

  it('после «свапа» страницы отвалившийся узел вычищается из store, новый — инициализируется', () => {
    const c1 = mount(3);
    boot();
    const oldRoot = c1.root;
    expect(store().has(oldRoot)).toBe(true);

    // «Свап» ClientRouter: старый DOM уехал целиком, приехал новый.
    const c2 = mount(2);
    expect(document.contains(oldRoot)).toBe(false);
    document.dispatchEvent(new Event('astro:page-load'));

    expect(store().has(oldRoot)).toBe(false);
    expect(store().has(c2.root)).toBe(true);
    expect(store().size).toBe(1);
    expect(c2.dots()).toHaveLength(2);
    expect(c2.root.classList.contains('is-ready')).toBe(true);
  });
});
