/**
 * Unit-тесты чистого ядра позиционирования (src/lib/positioning.ts):
 * flip у края вьюпорта, shift (зажим в padding), уважение offset.
 * DOM не нужен — ядро принимает прямоугольники числами.
 */
import { describe, expect, it } from 'vitest';
import { computePositionFromRects } from '../positioning';

const viewport = { width: 1000, height: 800 };
const floating = { width: 200, height: 100 };

/** Триггер посреди вьюпорта — места хватает с любой стороны. */
const centered = { top: 400, left: 480, width: 40, height: 20 };

describe('computePositionFromRects — базовая геометрия и offset', () => {
  it('top: бабл над триггером на offset, центрирован по поперечной оси', () => {
    const pos = computePositionFromRects(centered, floating, viewport, {
      placement: 'top',
      offset: 8,
    });
    expect(pos.placement).toBe('top');
    expect(pos.top).toBe(centered.top - floating.height - 8); // 292
    expect(pos.left).toBe(centered.left + (centered.width - floating.width) / 2); // 400
  });

  it('right: зазор между триггером и элементом равен offset', () => {
    const pos = computePositionFromRects(centered, floating, viewport, {
      placement: 'right',
      offset: 12,
    });
    expect(pos.placement).toBe('right');
    expect(pos.left).toBe(centered.left + centered.width + 12);
    expect(pos.top).toBe(centered.top + (centered.height - floating.height) / 2);
  });

  it('дефолты: placement bottom, offset 8', () => {
    const pos = computePositionFromRects(centered, floating, viewport);
    expect(pos.placement).toBe('bottom');
    expect(pos.top).toBe(centered.top + centered.height + 8);
  });
});

describe('computePositionFromRects — flip у края вьюпорта', () => {
  it('top у верхнего края → переворачивается в bottom', () => {
    const trigger = { top: 20, left: 480, width: 40, height: 20 };
    const pos = computePositionFromRects(trigger, floating, viewport, {
      placement: 'top',
      offset: 8,
    });
    expect(pos.placement).toBe('bottom');
    expect(pos.top).toBe(trigger.top + trigger.height + 8); // 48
  });

  it('bottom у нижнего края → переворачивается в top', () => {
    const trigger = { top: 750, left: 480, width: 40, height: 20 };
    const pos = computePositionFromRects(trigger, floating, viewport, {
      placement: 'bottom',
      offset: 8,
    });
    expect(pos.placement).toBe('top');
    expect(pos.top).toBe(trigger.top - floating.height - 8); // 642
  });

  it('left у левого края → переворачивается в right', () => {
    const trigger = { top: 400, left: 10, width: 40, height: 20 };
    const pos = computePositionFromRects(trigger, floating, viewport, {
      placement: 'left',
      offset: 8,
    });
    expect(pos.placement).toBe('right');
    expect(pos.left).toBe(trigger.left + trigger.width + 8);
  });

  it('тесно с ОБЕИХ сторон: выбирается сторона с меньшим вылетом, затем зажим', () => {
    // Вьюпорт 200px высотой, элемент 160px: сверху места 22px, снизу 142px.
    const smallViewport = { width: 1000, height: 200 };
    const tall = { width: 200, height: 160 };
    const trigger = { top: 30, left: 480, width: 40, height: 20 };
    const pos = computePositionFromRects(trigger, tall, smallViewport, {
      placement: 'top',
      offset: 8,
      padding: 8,
    });
    expect(pos.placement).toBe('bottom'); // снизу вылет меньше
    // Зажим по главной оси: maxTop = max(8, 200 - 160 - 8) = 32.
    expect(pos.top).toBe(32);
  });

  it('места хватает — сторона НЕ меняется', () => {
    const pos = computePositionFromRects(centered, floating, viewport, { placement: 'left' });
    expect(pos.placement).toBe('left');
  });
});

describe('computePositionFromRects — shift (зажим в padding)', () => {
  it('триггер у левого края, placement top: left зажат в padding, сторона не меняется', () => {
    const trigger = { top: 400, left: 4, width: 40, height: 20 };
    const pos = computePositionFromRects(trigger, floating, viewport, {
      placement: 'top',
      offset: 8,
      padding: 8,
    });
    // Центрирование дало бы left = 4 + (40-200)/2 = -76 → зажим в 8.
    expect(pos.placement).toBe('top');
    expect(pos.left).toBe(8);
    expect(pos.top).toBe(trigger.top - floating.height - 8);
  });

  it('триггер у правого края: left зажат в viewport − width − padding', () => {
    const trigger = { top: 400, left: 970, width: 20, height: 20 };
    const pos = computePositionFromRects(trigger, floating, viewport, {
      placement: 'bottom',
      offset: 8,
      padding: 8,
    });
    expect(pos.placement).toBe('bottom');
    expect(pos.left).toBe(viewport.width - floating.width - 8); // 792
  });

  it('кастомный padding уважается', () => {
    const trigger = { top: 400, left: 0, width: 10, height: 20 };
    const pos = computePositionFromRects(trigger, floating, viewport, {
      placement: 'top',
      padding: 24,
    });
    expect(pos.left).toBe(24);
  });

  it('элемент шире вьюпорта: прижимается к padding слева (контент читаем с начала)', () => {
    const wide = { width: 1200, height: 100 };
    const pos = computePositionFromRects(centered, wide, viewport, { placement: 'bottom' });
    expect(pos.left).toBe(8);
  });
});
