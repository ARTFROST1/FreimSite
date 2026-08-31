/**
 * Позиционирование плавающих элементов (тултип, дропдаун) относительно
 * триггера: flip на противоположную сторону у края вьюпорта + shift
 * (зажим координат в пределы вьюпорта с отступом `padding`).
 *
 * Адаптация starwind-ui positioning.ts (MIT), сознательно упрощённая:
 * четыре стороны, поперечная ось всегда центрируется по триггеру —
 * каскад из 12 кандидатов со скорингом здесь не нужен.
 *
 * CSS Anchor Positioning НЕ используется — на сегодня Chromium-only.
 *
 * Координаты — вьюпортные (система getBoundingClientRect): применять к
 * элементу с `position: fixed`, лежащему ПРЯМЫМ потомком <body>. Любой
 * transform на предке (в т.ч. отработавший data-reveal из global.css,
 * который оставляет `translateY(0)`) делает fixed локальным — поэтому
 * Tooltip/Dropdown портализуют плавающий элемент в <body> на время показа.
 *
 * Чистая математика вынесена в `computePositionFromRects` — её гоняет
 * unit-тест `src/lib/__tests__/positioning.test.ts` без DOM.
 */

export type Placement = 'top' | 'bottom' | 'left' | 'right';

export interface PositionOptions {
  /** Предпочтительная сторона. @default 'bottom' */
  placement?: Placement;
  /** Зазор между триггером и плавающим элементом, px. @default 8 */
  offset?: number;
  /** Минимальный отступ от краёв вьюпорта, px. @default 8 */
  padding?: number;
}

export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PositionResult {
  top: number;
  left: number;
  /** Итоговая сторона (после возможного flip) — для transform-origin/стрелки. */
  placement: Placement;
}

const OPPOSITE: Record<Placement, Placement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

interface Point {
  top: number;
  left: number;
}

/** «Идеальная» позиция для стороны: по главной оси — offset от триггера,
 *  по поперечной — центрирование относительно триггера. */
function positionFor(placement: Placement, trigger: RectLike, floating: Size, offset: number): Point {
  const centerLeft = trigger.left + (trigger.width - floating.width) / 2;
  const centerTop = trigger.top + (trigger.height - floating.height) / 2;
  switch (placement) {
    case 'top':
      return { top: trigger.top - floating.height - offset, left: centerLeft };
    case 'bottom':
      return { top: trigger.top + trigger.height + offset, left: centerLeft };
    case 'left':
      return { top: centerTop, left: trigger.left - floating.width - offset };
    case 'right':
      return { top: centerTop, left: trigger.left + trigger.width + offset };
  }
}

/** Насколько (px) позиция вылезает за вьюпорт по ГЛАВНОЙ оси стороны.
 *  Поперечные вылеты не считаются — их лечит shift, а не flip. */
function mainOverflow(
  placement: Placement,
  position: Point,
  floating: Size,
  viewport: Size,
  padding: number,
): number {
  switch (placement) {
    case 'top':
      return Math.max(0, padding - position.top);
    case 'bottom':
      return Math.max(0, position.top + floating.height - (viewport.height - padding));
    case 'left':
      return Math.max(0, padding - position.left);
    case 'right':
      return Math.max(0, position.left + floating.width - (viewport.width - padding));
  }
}

/**
 * Чистое ядро: считает позицию по прямоугольникам, без DOM.
 *
 * flip: если предпочтительная сторона вылезает за вьюпорт по главной оси,
 * а противоположная вылезает СТРОГО меньше — берётся противоположная
 * (когда тесно с обеих сторон, выигрывает менее тесная; при равенстве
 * остаётся предпочтительная — меньше «прыжков» при ресайзе).
 *
 * shift: обе координаты зажимаются в [padding, viewport − size − padding];
 * если плавающий элемент шире/выше вьюпорта, он прижимается к padding
 * сверху/слева (контент читаем с начала).
 */
export function computePositionFromRects(
  trigger: RectLike,
  floating: Size,
  viewport: Size,
  options: PositionOptions = {},
): PositionResult {
  const { placement = 'bottom', offset = 8, padding = 8 } = options;

  let side = placement;
  let position = positionFor(side, trigger, floating, offset);

  const overflow = mainOverflow(side, position, floating, viewport, padding);
  if (overflow > 0) {
    const flippedSide = OPPOSITE[side];
    const flippedPosition = positionFor(flippedSide, trigger, floating, offset);
    if (mainOverflow(flippedSide, flippedPosition, floating, viewport, padding) < overflow) {
      side = flippedSide;
      position = flippedPosition;
    }
  }

  const maxLeft = Math.max(padding, viewport.width - floating.width - padding);
  const maxTop = Math.max(padding, viewport.height - floating.height - padding);

  return {
    left: Math.min(Math.max(padding, position.left), maxLeft),
    top: Math.min(Math.max(padding, position.top), maxTop),
    placement: side,
  };
}

/**
 * DOM-обёртка: меряет триггер, плавающий элемент и вьюпорт сама.
 * Плавающий элемент к моменту вызова должен быть видим (не display:none),
 * иначе offsetWidth/offsetHeight — нули.
 */
export function computePosition(
  trigger: Element,
  floating: HTMLElement,
  options: PositionOptions = {},
): PositionResult {
  const rect = trigger.getBoundingClientRect();
  return computePositionFromRects(
    { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    { width: floating.offsetWidth, height: floating.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
    options,
  );
}
