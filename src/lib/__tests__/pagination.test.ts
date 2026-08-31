/**
 * Unit-тесты чистого ядра пагинации (src/lib/pagination.ts): окно видимых
 * номеров с многоточиями, URL страниц (первая = корень списка), ссылки
 * first/prev/next/last и подстановка в подписи.
 */
import { describe, expect, it } from 'vitest';
import { formatPageLabel, pageUrl, paginationLinks, visiblePages } from '../pagination';

describe('visiblePages — окно ±2 вокруг текущей с многоточиями', () => {
  it('мало страниц — показываем все, без многоточий', () => {
    expect(visiblePages(1, 1)).toEqual([1]);
    expect(visiblePages(2, 3)).toEqual([1, 2, 3]);
    expect(visiblePages(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('текущая в начале — хвост схлопывается в многоточие перед последней', () => {
    expect(visiblePages(1, 10)).toEqual([1, 2, 3, 'ellipsis', 10]);
    expect(visiblePages(2, 10)).toEqual([1, 2, 3, 4, 'ellipsis', 10]);
  });

  it('текущая в середине — многоточия с обеих сторон', () => {
    expect(visiblePages(6, 12)).toEqual([1, 'ellipsis', 4, 5, 6, 7, 8, 'ellipsis', 12]);
  });

  it('текущая в конце — многоточие только после первой', () => {
    expect(visiblePages(10, 10)).toEqual([1, 'ellipsis', 8, 9, 10]);
  });

  it('разрыв ровно в одну страницу не прячется за многоточием', () => {
    // 1 [3 4 5 6 7] 10 → между 1 и 3 ровно одна страница (2): показываем её.
    expect(visiblePages(5, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 'ellipsis', 10]);
    // Симметрично с хвоста: 1 … [4..8] 10 → между 8 и 10 ровно 9.
    expect(visiblePages(6, 10)).toEqual([1, 'ellipsis', 4, 5, 6, 7, 8, 9, 10]);
  });

  it('уважает параметр around', () => {
    expect(visiblePages(6, 12, 1)).toEqual([1, 'ellipsis', 5, 6, 7, 'ellipsis', 12]);
    expect(visiblePages(6, 12, 0)).toEqual([1, 'ellipsis', 6, 'ellipsis', 12]);
  });

  it('зажимает выход за диапазон и пустой список при total < 1', () => {
    expect(visiblePages(0, 5)).toEqual(visiblePages(1, 5));
    expect(visiblePages(99, 5)).toEqual(visiblePages(5, 5));
    expect(visiblePages(1, 0)).toEqual([]);
  });
});

describe('pageUrl — первая страница это корень списка', () => {
  it('страница 1 → base без сегмента (существующий URL не меняется)', () => {
    expect(pageUrl(1, { base: '/blog/' })).toBe('/blog/');
    expect(pageUrl(0, { base: '/blog/' })).toBe('/blog/');
  });

  it('страницы 2+ → base/page/N/ с завершающим слэшем', () => {
    expect(pageUrl(2, { base: '/blog/' })).toBe('/blog/page/2/');
    expect(pageUrl(15, { base: '/blog/' })).toBe('/blog/page/15/');
  });

  it('достраивает слэш у base и принимает свой сегмент', () => {
    expect(pageUrl(3, { base: '/news' })).toBe('/news/page/3/');
    expect(pageUrl(3, { base: '/news/', segment: 'p' })).toBe('/news/p/3/');
  });
});

describe('paginationLinks — null там, где идти некуда', () => {
  const href = (n: number) => pageUrl(n, { base: '/blog/' });

  it('первая страница: first/previous = null', () => {
    expect(paginationLinks(1, 4, href)).toEqual({
      first: null,
      previous: null,
      next: '/blog/page/2/',
      last: '/blog/page/4/',
    });
  });

  it('середина: все четыре ссылки; previous со второй ведёт на корень', () => {
    expect(paginationLinks(2, 4, href)).toEqual({
      first: '/blog/',
      previous: '/blog/',
      next: '/blog/page/3/',
      last: '/blog/page/4/',
    });
  });

  it('последняя страница: next/last = null', () => {
    expect(paginationLinks(4, 4, href)).toEqual({
      first: '/blog/',
      previous: '/blog/page/3/',
      next: null,
      last: null,
    });
  });

  it('единственная страница: всё null', () => {
    expect(paginationLinks(1, 1, href)).toEqual({
      first: null,
      previous: null,
      next: null,
      last: null,
    });
  });
});

describe('formatPageLabel', () => {
  it('подставляет {current}/{total}/{n}', () => {
    expect(formatPageLabel('Страница {current} из {total}', { current: 2, total: 7 })).toBe(
      'Страница 2 из 7',
    );
    expect(formatPageLabel('Страница {n}', { n: 3 })).toBe('Страница 3');
  });

  it('неизвестные плейсхолдеры не трогает, отсутствующие значения — пустая строка', () => {
    expect(formatPageLabel('{foo} {n}', {})).toBe('{foo} ');
  });
});
