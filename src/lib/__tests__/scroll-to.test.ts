import { describe, expect, it } from 'vitest';
import {
  computeTargetY,
  scrollDuration,
  settleAction,
  SETTLE_BUDGET_MS,
  STEADY_FRAMES,
  TOLERANCE,
} from '../scroll-to';

/**
 * Три числа, которые решают, окажется ли карточка формы в экране целиком.
 * DOM-часть scroll-to.ts (замеры шапки/острова, rAF, отмена по колесу) в
 * node-окружении не воспроизводится — она проверяется только в браузере;
 * здесь фиксируем математику, из-за которой на боевом проекте ловились реальные баги:
 * карточка под мобильным островом, «уплывшая» вниз на широком мониторе и
 * цель за концом документа.
 */

/** Базовые замеры: карточка 600px на экране 900px, шапка 72+8, острова нет. */
const base = {
  elementTop: 5000,
  elementHeight: 600,
  viewportHeight: 900,
  topReserve: 80,
  bottomReserve: 0,
  maxScrollY: 20000,
};

describe('computeTargetY', () => {
  it('вписывает элемент целиком: свободное место делится пополам', () => {
    // Экран подобран так, чтобы половина остатка была МЕНЬШЕ потолка и кейс
    // проверял именно деление: free = 780 - 80 - 0 - 600 = 100 → gap = 50.
    expect(computeTargetY({ ...base, viewportHeight: 780 })).toBe(5000 - 80 - 50);
  });

  it('половина остатка упирается в потолок MAX_GAP', () => {
    // free = 900 - 80 - 0 - 600 = 220 → половина 110, но зазор не больше 80.
    expect(computeTargetY(base)).toBe(5000 - 80 - 80);
  });

  it('не уплывает вниз на широком экране — зазор упирается в потолок', () => {
    // Экран вдвое выше карточки: половина остатка была бы 500px, и карточка
    // уехала бы в нижнюю половину экрана, оторвавшись от заголовка.
    const y = computeTargetY({ ...base, viewportHeight: 1800 });
    expect(y).toBe(5000 - 80 - 80);
  });

  it('резервирует низ под липкий остров — иначе кнопка уходит под него', () => {
    // free = 900 - 80 - 140 - 600 = 80 → gap = 40 (меньше потолка).
    expect(computeTargetY({ ...base, bottomReserve: 140 })).toBe(5000 - 80 - 40);
  });

  it('элемент выше свободного окна — прижимаем верх, а не центрируем', () => {
    // free < 0: центрирование увело бы начало формы под шапку.
    expect(computeTargetY({ ...base, elementHeight: 1200 })).toBe(5000 - 80 - 12);
  });

  it("block:'start' игнорирует свободное место и всегда ставит верх под шапку", () => {
    expect(computeTargetY({ ...base, block: 'start' })).toBe(5000 - 80 - 12);
  });

  it('зажимает цель в пределы документа', () => {
    expect(computeTargetY({ ...base, maxScrollY: 4000 })).toBe(4000);
    expect(computeTargetY({ ...base, elementTop: 40 })).toBe(0);
    // Документ короче экрана — прокручивать некуда.
    expect(computeTargetY({ ...base, maxScrollY: 0 })).toBe(0);
  });
});

describe('scrollDuration — перелёт целиком, без телепортов', () => {
  it('ближний якорь проходится за нижнюю границу коридора', () => {
    expect(scrollDuration(0)).toBe(350);
    expect(scrollDuration(1000)).toBe(350);
  });

  it('дальний якорь главной (~13 экранов) укладывается в секунду', () => {
    // 12 000px — реальное расстояние до самого глубокого якоря шапки.
    // Пролёт целиком, поэтому длительность обязана быть заметной, но не
    // мучительной: дольше секунды человек решает, что клик не сработал.
    const long = scrollDuration(12000);
    expect(long).toBeGreaterThan(800);
    expect(long).toBeLessThanOrEqual(900);
  });

  it('растёт по корню: вчетверо дальше — вдвое дольше', () => {
    // Именно это делает ближний и дальний переход ОДНИМ движением разной
    // длины, а не рывком против ползания. Значения взяты внутри свободного
    // диапазона, между нижней и верхней границей, иначе зажимы скрыли бы
    // саму зависимость.
    const near = scrollDuration(2000); // 358 мс
    const far = scrollDuration(8000); // 715 мс — вчетверо дальше
    expect(near).toBeGreaterThan(350);
    expect(far).toBeLessThan(900);
    expect(far / near).toBeCloseTo(2, 1);
  });

  it('верхняя граница жёсткая', () => {
    expect(scrollDuration(100000)).toBe(900);
  });

  it('не зависит от направления', () => {
    expect(scrollDuration(-4000)).toBe(scrollDuration(4000));
  });
});

/* ==========================================================================
   Доводка до устойчивости: решение цикла и его жизнь на бумаге
   ==========================================================================

   Ниже проверяется вторая половина модуля — та, из-за которой человек на
   медленной сети оказывался НА ФИКСИРОВАННОМ РАССТОЯНИИ выше цели
   (scroll-pitfalls.md §9). Сама по себе `settleAction` — три строчки, и по
   ним не видно, ради чего они написаны. Поэтому кроме табличных проверок
   приоритетов здесь есть «жизнь цикла на бумаге»: последовательность кадров
   как массив геометрий, прогнанная через НАСТОЯЩИЕ `computeTargetY` и
   `settleAction`. Кадры — единственное, что здесь выдумано; вся арифметика
   между ними принадлежит модулю.
   ========================================================================== */

describe('settleAction — приоритет решений', () => {
  it('бюджет сильнее промаха: за SETTLE_BUDGET_MS цель признаётся недостижимой', () => {
    // Промах огромный, но время вышло: дальше это уже не доводка, а борьба
    // со страницей, которая уезжает быстрее, чем мы её догоняем.
    expect(settleAction(5000, 0, SETTLE_BUDGET_MS + 1)).toBe('done');
    // Ровно на границе бюджета — ещё работаем (проверка строгая, `>`).
    expect(settleAction(5000, 0, SETTLE_BUDGET_MS)).toBe('scroll');
  });

  it('промах больше допуска — двигаем страницу', () => {
    expect(settleAction(TOLERANCE + 1, 0, 0)).toBe('scroll');
    expect(settleAction(1903, 2, 0)).toBe('scroll'); // и накопленная выдержка не спасает
  });

  it('ровно на границе допуска — уже НЕ двигаем', () => {
    // `getBoundingClientRect` отдаёт дробные значения, а `scrollTo` округляет
    // по-своему в каждом движке: дёргать страницу на этом пикселе — вечный цикл.
    expect(settleAction(TOLERANCE, 0, 0)).not.toBe('scroll');
    expect(settleAction(-TOLERANCE, 0, 0)).not.toBe('scroll');
  });

  it('выдержка копится STEADY_FRAMES кадров, и только потом «приехали»', () => {
    expect(settleAction(0, 0, 0)).toBe('steady');
    expect(settleAction(0, 1, 0)).toBe('steady');
    expect(settleAction(0, STEADY_FRAMES - 1, 0)).toBe('done');
  });

  it('знак промаха не важен — допуск симметричен', () => {
    expect(settleAction(-(TOLERANCE + 1), 0, 0)).toBe('scroll');
    expect(settleAction(-TOLERANCE, 0, 0)).toBe(settleAction(TOLERANCE, 0, 0));
    expect(settleAction(-0.5, 1, 0)).toBe(settleAction(0.5, 1, 0));
  });
});

/* --------------------------------------------------------------------------
   Числа из замера 26.08.2026 (Chromium, дроссель 900 кбит/с, 390×844,
   холодный заход по якорю) — scroll-pitfalls.md §9.
   -------------------------------------------------------------------------- */

/** Высота мобильной пин-распорки GSAP. Ровно на столько человек оставался
 *  выше цели, когда чанк GSAP доезжал уже после доводки. */
const PIN_PX = 1903;

/** Куда страница вставала к 6.6 с — по раскладке БЕЗ пина. */
const TARGET_NO_PIN = 5891;

/** Экран из того же замера. */
const VIEWPORT_H = 844;

/** Резерв сверху = высота шапки + EDGE_GAP(8). 96px — реальная высота
 *  десктопной шапки из §4 (против 80px, которые обещал `scroll-padding-top`). */
const HEADER_TALL = 96 + 8;

/** Она же после сжатия: Header.astro меняет `py-4` на `py-2` при scrollY > 60,
 *  это ровно 16px высоты. Высота ДОКУМЕНТА при этом не меняется. */
const HEADER_SHRINK_PX = 16;
const HEADER_SHORT = HEADER_TALL - HEADER_SHRINK_PX;

/** MIN_GAP из scroll-to.ts: в режиме `start` над элементом всегда 12px воздуха. */
const MIN_GAP = 12;

/** Кадр 60 fps — только чтобы `elapsed` в модели рос как в жизни. */
const FRAME_MS = 16;

/** Верх элемента, при котором цель по раскладке без пина = TARGET_NO_PIN. */
const ELEMENT_TOP = TARGET_NO_PIN + HEADER_TALL + MIN_GAP;
const ELEMENT_H = 700;
const DOC_NO_PIN = ELEMENT_TOP + ELEMENT_H + 800;

/** Снимок раскладки на одном кадре. */
interface Frame {
  elementTop: number;
  docHeight: number;
  topReserve: number;
}

interface Settlement {
  frame: number;
  y: number;
}

/**
 * Жизнь цикла на бумаге: активная доводка плюс сторож раскладки.
 *
 * Повторяет структуру `settleTo` + `watchLayout`, но без rAF и DOM:
 *  • пока цикл активен — каждый кадр пересчитываем цель и слушаем `settleAction`;
 *  • на `'done'` цикл засыпает и остаётся только сторож;
 *  • сторож просыпается на изменении ВЫСОТЫ ДОКУМЕНТА и запускает доводку заново.
 *
 * Сторож здесь намеренно наивный — он смотрит только на высоту корня. Именно
 * поэтому сценарий со сжатием шапки его и ловит.
 */
function runFrames(frames: readonly Frame[]): { y: number; settlements: Settlement[] } {
  let y = 0;
  let steady = 0;
  let startedAt = 0;
  let active = true;
  let watchedHeight = frames[0].docHeight;
  const settlements: Settlement[] = [];

  frames.forEach((frame, i) => {
    const now = i * FRAME_MS;

    if (!active) {
      if (frame.docHeight === watchedHeight) return; // сторож молчит — раскладка стоит
      watchedHeight = frame.docHeight; // цель уехала → доводим заново
      active = true;
      steady = 0;
      startedAt = now;
    }

    const desired = computeTargetY({
      elementTop: frame.elementTop,
      elementHeight: ELEMENT_H,
      viewportHeight: VIEWPORT_H,
      topReserve: frame.topReserve,
      bottomReserve: 0,
      maxScrollY: Math.max(0, frame.docHeight - VIEWPORT_H),
      block: 'start',
    });

    const action = settleAction(desired - y, steady, now - startedAt);
    if (action === 'done') {
      active = false;
      watchedHeight = frame.docHeight;
      settlements.push({ frame: i, y });
      return;
    }
    if (action === 'scroll') {
      steady = 0;
      y = desired;
    } else {
      steady += 1;
    }
  });

  return { y, settlements };
}

/** Раскладка без пина — столько кадров, сколько попросят. */
function calmFrames(count: number, topReserve = HEADER_TALL): Frame[] {
  return Array.from({ length: count }, () => ({
    elementTop: ELEMENT_TOP,
    docHeight: DOC_NO_PIN,
    topReserve,
  }));
}

describe('жизнь цикла на бумаге: поздний пин (§9)', () => {
  /** Кадр, на котором доезжает чанк GSAP и строится пин. */
  const PIN_FRAME = 8;

  const frames = calmFrames(20).map((f, i) =>
    i < PIN_FRAME ? f : { ...f, elementTop: f.elementTop + PIN_PX, docHeight: f.docHeight + PIN_PX },
  );

  it('первый приезд наступает раньше пина — и он ещё не окончательный', () => {
    const { settlements } = runFrames(frames);
    // Кадр 0 — прыжок, кадры 1..2 — накопление выдержки, кадр 3 — «приехали».
    expect(settlements[0]).toEqual({ frame: 3, y: TARGET_NO_PIN });
    expect(settlements[0].frame).toBeLessThan(PIN_FRAME);
  });

  it('наивная остановка «по первому попаданию» бросила бы страницу на 1903px выше цели', () => {
    const { settlements } = runFrames(frames);
    const naiveY = settlements[0].y;
    const finalY = settlements[settlements.length - 1].y;
    expect(finalY - naiveY).toBe(PIN_PX);
    expect(naiveY).toBe(TARGET_NO_PIN);
  });

  it('после пина цикл добирает цель и снова копит выдержку STEADY_FRAMES кадров', () => {
    const { y, settlements } = runFrames(frames);
    expect(y).toBe(TARGET_NO_PIN + PIN_PX);

    const last = settlements[settlements.length - 1];
    expect(last.y).toBe(TARGET_NO_PIN + PIN_PX);
    // Кадр пина — рывок, дальше ровно STEADY_FRAMES кадров без промаха.
    expect(last.frame).toBe(PIN_FRAME + STEADY_FRAMES);
  });

  it('без изменения высоты цикл больше не просыпается — сторож ничего не стоит', () => {
    const { settlements } = runFrames(calmFrames(20));
    expect(settlements).toEqual([{ frame: 3, y: TARGET_NO_PIN }]);
  });
});

describe('жизнь цикла на бумаге: сжатие шапки (§10)', () => {
  it('цель до и после сжатия отличается ровно на 16px при неизменной высоте документа', () => {
    const geometry = {
      elementTop: ELEMENT_TOP,
      elementHeight: ELEMENT_H,
      viewportHeight: VIEWPORT_H,
      bottomReserve: 0,
      maxScrollY: DOC_NO_PIN - VIEWPORT_H,
      block: 'start' as const,
    };
    const tall = computeTargetY({ ...geometry, topReserve: HEADER_TALL });
    const short = computeTargetY({ ...geometry, topReserve: HEADER_SHORT });

    expect(tall).toBe(TARGET_NO_PIN);
    expect(short - tall).toBe(HEADER_SHRINK_PX);
    // Высота документа у обеих геометрий одна и та же — наблюдателю за корнем
    // здесь нечего заметить.
    expect(geometry.maxScrollY).toBe(DOC_NO_PIN - VIEWPORT_H);
  });

  it('сжатие ВО ВРЕМЯ доводки цикл ловит сам — цель пересчитывается каждый кадр', () => {
    // Шапка сжимается на кадре 1: scrollY уже больше 60px после первого прыжка.
    const frames = calmFrames(12).map((f, i) =>
      i === 0 ? f : { ...f, topReserve: HEADER_SHORT },
    );
    expect(runFrames(frames).y).toBe(TARGET_NO_PIN + HEADER_SHRINK_PX);
  });

  it('сжатие ПОСЛЕ приезда наблюдатель за одной высотой корня проспал бы', () => {
    // Ради этого `watchLayout` наблюдает ещё и саму шапку: высота документа не
    // меняется, поэтому ResizeObserver на корне не просыпается, и человек
    // остаётся ровно на высоту сжатия в стороне от цели. Замер 26.08.2026
    // показывал промах то +12px, то +28px — разница ровно в эти 16px, а какая
    // из величин выпадет, решала гонка между сжатием и последним кадром доводки.
    const frames = calmFrames(12).map((f, i) =>
      i < 6 ? f : { ...f, topReserve: HEADER_SHORT },
    );
    const { y, settlements } = runFrames(frames);

    expect(settlements).toEqual([{ frame: 3, y: TARGET_NO_PIN }]);
    expect(TARGET_NO_PIN + HEADER_SHRINK_PX - y).toBe(HEADER_SHRINK_PX);
  });
});
