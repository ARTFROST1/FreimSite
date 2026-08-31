import { describe, expect, it } from 'vitest';
import { activeStepIndex, stepsProgress } from '../scroll-progress';

/**
 * Только чистая математика — DOM-часть (`getBoundingClientRect`, rAF-throttle
 * в `StepsSection.astro`) проверяется вручную в браузере, как и у
 * `scroll-to.ts` (см. doc-comment scroll-progress.ts и
 * `src/lib/__tests__/scroll-to.test.ts` за тем же разделением).
 */

/** Экран 900px, блок высотой 600px — базовые замеры для большинства кейсов. */
const base = { top: 0, height: 600, viewportHeight: 900 };

describe('stepsProgress', () => {
  it('блок ещё далеко внизу экрана — прогресс 0', () => {
    // rect.top больше startTop (0.72 * 900 = 648) → числитель отрицательный.
    expect(stepsProgress({ ...base, top: 700 })).toBe(0);
  });

  it('верх блока ровно в стартовой точке — прогресс 0', () => {
    expect(stepsProgress({ ...base, top: 900 * 0.72 })).toBe(0);
  });

  it('прогресс растёт линейно между стартом и концом коридора', () => {
    // span = 900*0.3 + 600 = 870. На середине пути (top сдвинут на span/2
    // ниже нуля от старта) прогресс должен быть 0.5.
    const startTop = 900 * 0.72;
    const span = 900 * 0.3 + 600;
    const top = startTop - span * 0.5;
    expect(stepsProgress({ ...base, top })).toBeCloseTo(0.5, 6);
  });

  it('блок поднялся выше конца коридора — прогресс зажат в 1', () => {
    const startTop = 900 * 0.72;
    const span = 900 * 0.3 + 600;
    expect(stepsProgress({ ...base, top: startTop - span * 1.5 })).toBe(1);
  });

  it('уважает кастомные startVh/spanVh', () => {
    const startVh = 0.5;
    const spanVh = 0.1;
    const startTop = 900 * startVh;
    const span = 900 * spanVh + 600;
    expect(stepsProgress({ ...base, top: startTop, startVh, spanVh })).toBe(0);
    expect(stepsProgress({ ...base, top: startTop - span, startVh, spanVh })).toBe(1);
  });

  it('нулевой коридор (пустой блок на экране нулевой высоты) не делит на ноль', () => {
    expect(stepsProgress({ top: 0, height: 0, viewportHeight: 0, spanVh: 0 })).toBe(0);
  });
});

describe('activeStepIndex', () => {
  it('прогресс 0 даёт первый шаг', () => {
    expect(activeStepIndex(0, 6)).toBe(0);
  });

  it('прогресс 1 даёт ПОСЛЕДНИЙ индекс, а не выход за границы массива', () => {
    expect(activeStepIndex(1, 6)).toBe(5);
  });

  it('режет коридор на равные отрезки', () => {
    // 6 шагов → границы на 1/6, 2/6, …; 0.5 попадает в третий отрезок (индекс 2).
    expect(activeStepIndex(0.49, 6)).toBe(2);
    expect(activeStepIndex(0.5, 6)).toBe(3);
  });

  it('пустой список шагов возвращает -1', () => {
    expect(activeStepIndex(0.5, 0)).toBe(-1);
  });
});
