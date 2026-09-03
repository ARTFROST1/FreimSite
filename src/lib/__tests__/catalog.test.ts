import { describe, it, expect } from 'vitest';
import { buildCatalogPaths, categoryPath, productHref, sortProducts } from '../catalog';

const cats = [
  { id: 'okna', name: 'Окна', priority: 2 },
  { id: 'okna-plastikovye', name: 'Пластиковые окна', parent: 'okna', priority: 1 },
  { id: 'dveri', name: 'Двери', priority: 1 },
];
const prods = [
  { id: 'okno-1', data: { title: 'Окно', category: 'okna-plastikovye', draft: false, priority: 0 } },
  { id: 'dver-1', data: { title: 'Дверь', category: 'dveri', draft: true, priority: 0 } },
];

/**
 * Порядок товаров в сетке — единственный, который видит клиент, и правит он
 * его полем «Порядок» (`priority`) в портале. Правило зафиксировано тестом,
 * потому что «просто отсортировано» — не контракт: без второго ключа порядок
 * товаров с одинаковым priority зависел бы от порядка чтения файлов с диска
 * и менялся бы между машинами при одном и том же контенте.
 */
describe('sortProducts', () => {
  const p = (id: string, title: string, priority: number) => ({ id, data: { title, priority } });

  it('больше priority — выше', () => {
    const sorted = sortProducts([p('a', 'А', 1), p('b', 'Б', 5), p('c', 'В', 3)] as never);
    expect(sorted.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('при равном priority — по названию, русским алфавитом', () => {
    const sorted = sortProducts([p('c', 'Ярость', 0), p('a', 'Ёлка', 0), p('b', 'Автор', 0)] as never);
    expect(sorted.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('priority по умолчанию 0 — товар без поля не всплывает и не тонет', () => {
    const noPriority = { id: 'x', data: { title: 'Аноним' } };
    const sorted = sortProducts([p('plus', 'Ббб', 1), noPriority, p('minus', 'Ааа', -1)] as never);
    expect(sorted.map((x) => x.id)).toEqual(['plus', 'x', 'minus']);
  });

  it('не мутирует исходный массив', () => {
    const input = [p('a', 'А', 1), p('b', 'Б', 5)] as never;
    sortProducts(input);
    expect((input as { id: string }[]).map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('buildCatalogPaths', () => {
  it('builds category, subcategory and product paths; drafts excluded', () => {
    const paths = buildCatalogPaths(cats as never, prods as never).map((p) => p.params.slug);
    expect(paths).toContain('okna'); // развилка подкатегорий
    expect(paths).toContain('okna/okna-plastikovye'); // сетка товаров
    expect(paths).toContain('okna/okna-plastikovye/okno-1'); // страница товара
    expect(paths).toContain('dveri'); // сетка (нет детей)
    expect(paths).not.toContain('dveri/dver-1'); // draft исключён
  });

  it('throws a readable error for a product pointing at a missing category', () => {
    const bad = [{ id: 'x', data: { title: 'X', category: 'net-takoy', draft: false } }];
    expect(() => buildCatalogPaths(cats as never, bad as never)).toThrow(/net-takoy/);
  });

  it('throws a readable error for a product assigned to a fork category (has subcategories)', () => {
    const orphan = [
      { id: 'okno-orphan', data: { title: 'Окно-сирота', category: 'okna', draft: false, priority: 0 } },
    ];
    expect(() => buildCatalogPaths(cats as never, orphan as never)).toThrow(/okno-orphan/);
    expect(() => buildCatalogPaths(cats as never, orphan as never)).toThrow(/okna/);
  });

  it('fork view carries subcategories sorted by priority desc then name', () => {
    const paths = buildCatalogPaths(cats as never, prods as never);
    const fork = paths.find((p) => p.params.slug === 'okna');
    expect(fork?.props.view).toBe('fork');
    if (fork?.props.view === 'fork') {
      expect(fork.props.subcategories.map((c) => c.id)).toEqual(['okna-plastikovye']);
    }
  });

  it('grid view for a leaf category with no children carries no subcategory', () => {
    const paths = buildCatalogPaths(cats as never, prods as never);
    const grid = paths.find((p) => p.params.slug === 'dveri');
    expect(grid?.props.view).toBe('grid');
    if (grid?.props.view === 'grid') {
      expect(grid.props.subcategory).toBeUndefined();
      expect(grid.props.products).toEqual([]); // dver-1 is a draft, excluded
    }
  });

  it('product view carries category + subcategory + resolved product', () => {
    const paths = buildCatalogPaths(cats as never, prods as never);
    const product = paths.find((p) => p.params.slug === 'okna/okna-plastikovye/okno-1');
    expect(product?.props.view).toBe('product');
    if (product?.props.view === 'product') {
      expect(product.props.category.id).toBe('okna');
      expect(product.props.subcategory?.id).toBe('okna-plastikovye');
      expect(product.props.product.id).toBe('okno-1');
    }
  });
});

describe('categoryPath', () => {
  it('returns the bare id for a top-level category', () => {
    expect(categoryPath(cats[0] as never, cats as never)).toBe('okna');
  });

  it('returns parent/id for a child category', () => {
    expect(categoryPath(cats[1] as never, cats as never)).toBe('okna/okna-plastikovye');
  });
});

describe('productHref', () => {
  it('builds /katalog/<cat>/<sub>/<slug>/ for a product in a subcategory', () => {
    expect(productHref(prods[0] as never, cats as never)).toBe('/katalog/okna/okna-plastikovye/okno-1/');
  });

  it('builds /katalog/<cat>/<slug>/ for a product in a top-level category', () => {
    const dverProd = { id: 'dver-1', data: { title: 'Дверь', category: 'dveri', draft: false, priority: 0 } };
    expect(productHref(dverProd as never, cats as never)).toBe('/katalog/dveri/dver-1/');
  });

  it('throws a readable error when the product category is missing', () => {
    const bad = { id: 'x', data: { title: 'X', category: 'net-takoy', draft: false } };
    expect(() => productHref(bad as never, cats as never)).toThrow(/net-takoy/);
  });
});
