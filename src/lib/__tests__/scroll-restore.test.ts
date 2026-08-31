/**
 * Восстановление позиции прокрутки по ОРИЕНТИРУ, а не по пикселям.
 *
 * Задача: высота длинной страницы не постоянна в течение её жизни — ленивый
 * пин (GSAP ScrollTrigger) добавляет распорку только после `load` и приближения
 * секции к экрану; плюс `content-visibility` держит непрорисованные секции на
 * оценочной высоте (`contain-intrinsic-size`), а поздние картинки и шрифты
 * двигают всё, что ниже. Один и тот же сохранённый пиксель в документе 18252px
 * и в документе 16164px — это РАЗНЫЙ контент (замер: две секции разницы), а
 * если сохранённый пиксель больше укоротившегося максимума, браузер зажимает
 * его в конец, и человек оказывается в футере.
 *
 * Поэтому запоминаем «на какой секции стоял верх экрана и насколько глубоко
 * в неё вошли», а при восстановлении считаем координату заново по фактической
 * раскладке. Разбор — docs/recipes/scroll-pitfalls.md §1.
 */
import { describe, expect, it } from 'vitest';
import { pickAnchor, anchorTarget, type Landmark } from '../scroll-restore';

/** Раскладка страницы, когда пин-распорка ПОСТРОЕНА (высота 18252). */
const WITH_PIN: Landmark[] = [
  { key: '#intro', top: 0, height: 900 },
  { key: '#about', top: 900, height: 1200 },
  { key: '#scene', top: 2100, height: 3000 }, // пин-сцена с распоркой
  { key: '#details', top: 5100, height: 500 },
  { key: '#form', top: 5600, height: 750 },
];

/** Та же страница сразу после свопа: пин ещё не построен — секция короче
 *  на 2000px, всё, что ниже, поднялось. */
const WITHOUT_PIN: Landmark[] = [
  { key: '#intro', top: 0, height: 900 },
  { key: '#about', top: 900, height: 1200 },
  { key: '#scene', top: 2100, height: 1000 },
  { key: '#details', top: 3100, height: 500 },
  { key: '#form', top: 3600, height: 750 },
];

describe('pickAnchor', () => {
  it('берёт секцию, на которой стоит верх экрана, и глубину входа в неё', () => {
    expect(pickAnchor(WITH_PIN, 5300)).toEqual({ key: '#details', within: 200, y: 5300 });
  });

  it('верх экрана ровно на границе секции — берётся нижняя из двух', () => {
    expect(pickAnchor(WITH_PIN, 5100)).toEqual({ key: '#details', within: 0, y: 5100 });
  });

  it('выше первого ориентира — первый ориентир с отрицательной глубиной', () => {
    const marks: Landmark[] = [{ key: '#about', top: 300, height: 500 }];
    expect(pickAnchor(marks, 100)).toEqual({ key: '#about', within: -200, y: 100 });
  });

  it('нет ориентиров — нечего запоминать', () => {
    expect(pickAnchor([], 500)).toBeNull();
  });

  it('дробные координаты округляются (getBoundingClientRect отдаёт float)', () => {
    const marks: Landmark[] = [{ key: '#a', top: 100.4, height: 500 }];
    expect(pickAnchor(marks, 300.6)).toEqual({ key: '#a', within: 200, y: 301 });
  });
});

describe('anchorTarget', () => {
  it('ГЛАВНОЕ: тот же контент, когда раскладка над секцией укоротилась', () => {
    // Человек стоял на «деталях», войдя в секцию на 200px (пин был построен).
    const anchor = pickAnchor(WITH_PIN, 5300)!;
    // После свопа пина нет — секция переехала на 3100.
    expect(anchorTarget(anchor, WITHOUT_PIN, 20000)).toBe(3300);
    // Наивное восстановление по пикселю увело бы на 5300 — это уже форма,
    // две секции ниже (ровно то, на что жаловались посетители).
  });

  it('раскладка не менялась — координата ровно та же', () => {
    const anchor = pickAnchor(WITH_PIN, 5300)!;
    expect(anchorTarget(anchor, WITH_PIN, 20000)).toBe(5300);
  });

  it('секция исчезла из разметки — откат на сырой пиксель', () => {
    const anchor = { key: '#gone', within: 200, y: 5300 };
    expect(anchorTarget(anchor, WITHOUT_PIN, 20000)).toBe(5300);
  });

  it('цель за пределами документа — зажимается в максимум, но не в отрицательное', () => {
    const anchor = pickAnchor(WITH_PIN, 5300)!;
    expect(anchorTarget(anchor, WITHOUT_PIN, 1000)).toBe(1000);
    expect(anchorTarget({ key: '#intro', within: -500, y: -500 }, WITH_PIN, 9000)).toBe(0);
  });
});
