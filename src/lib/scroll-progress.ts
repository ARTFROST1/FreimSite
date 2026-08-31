/**
 * ============================================================================
 *  scroll-progress.ts — линейный прогресс «докуда долистали» блок, без GSAP.
 * ----------------------------------------------------------------------------
 *  Портировано с боевого проекта, `StepsSection.astro` (заполняющаяся линия
 *  таймлайна «как заказать», :356-440). Исходный прототип гнал ту же анимацию через
 *  `ScrollTrigger.create({ trigger, start: 'top 72%', end: 'bottom 42%',
 *  onUpdate })`; здесь тот же видимый эффект посчитан вручную из
 *  `getBoundingClientRect()` — ваниль, без новой зависимости от GSAP ради
 *  одной заполняющейся линии.
 *
 *  ВЫВОД ФОРМУЛЫ (по образцу оригинала на боевом проекте: start='top 72%', end='bottom 42%',
 *  где 0.42 = startVh − spanVh = 0.72 − 0.30). Есть две контрольные точки:
 *   - progress = 0, когда верх блока (`rect.top`) опускается до `startVh·vh`
 *     (блок только показался в нижней части экрана — триггер стартует);
 *   - progress = 1, когда низ блока (`rect.top + rect.height`) поднимается до
 *     `(startVh - spanVh)·vh`, то есть `rect.top = (startVh - spanVh)·vh -
 *     rect.height` (последний шаг вошёл в верхнюю часть экрана).
 *   Знаменатель — разница `rect.top` между этими двумя точками:
 *     startVh·vh - ((startVh - spanVh)·vh - rect.height) = spanVh·vh + rect.height
 *   Отсюда:
 *     progress = clamp((startVh·vh − rect.top) / (spanVh·vh + rect.height), 0, 1)
 *   Чем выше блок (`rect.height`), тем длиннее коридор прокрутки, в котором
 *   линия заполняется, — список из десяти шагов не пробегает мгновенно.
 *
 *  Используется в `StepsSection.astro` так же, как `computeTargetY` в
 *  `scroll-to.ts` относится к `LeadSection.astro`: чистая математика здесь
 *  (проверяется тестом `src/lib/__tests__/scroll-progress.test.ts`), замеры
 *  DOM/rAF-throttle — в инлайн-скрипте секции.
 * ============================================================================
 */

export interface StepsProgressGeometry {
  /** `rect.top` контейнера шагов, координаты вьюпорта (как из
   *  `getBoundingClientRect()`). */
  top: number;
  /** `rect.height` того же контейнера. */
  height: number;
  viewportHeight: number;
  /** Доля высоты экрана, где стартует заполнение (0.72 по умолчанию — блок
   *  начинает заполняться, когда его верх поднялся выше 72% экрана считая
   *  сверху). */
  startVh?: number;
  /** Доля экрана, добавляемая к длине коридора прогресса поверх собственной
   *  высоты блока (0.30 по умолчанию). */
  spanVh?: number;
}

/** Прогресс заполнения линии, зажатый в [0, 1]. */
export function stepsProgress(geometry: StepsProgressGeometry): number {
  const { top, height, viewportHeight, startVh = 0.72, spanVh = 0.3 } = geometry;
  const startTop = viewportHeight * startVh;
  const span = viewportHeight * spanVh + height;
  if (span <= 0) return 0;
  const raw = (startTop - top) / span;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Индекс активного шага по прогрессу: коридор [0,1] режется на `total`
 * равных отрезков, `progress = 1` всегда даёт последний индекс (а не
 * `total`, что было бы выходом за границы массива).
 */
export function activeStepIndex(progress: number, total: number): number {
  if (total <= 0) return -1;
  const i = Math.floor(progress * total);
  return Math.min(total - 1, Math.max(0, i));
}
