/**
 * Каталог: чистая логика построения дерева категорий/товаров и статических
 * путей `/katalog/**`. Никакого Astro-рантайма — только типы содержимого —
 * поэтому модуль тестируется юнит-тестом без контейнера компонентов.
 *
 * ДЕРЕВО: `categories` — плоский массив с необязательным `parent` (двухуровневая
 * иерархия, см. `categorySchema` в src/config/schemas.ts). Категория без
 * `parent` — корень; у корня есть дети, если другая категория ссылается на
 * него через `parent`.
 *
 * ТРИ ВИДА СТРАНИЦ (`view` в props), которые рождает один и тот же корень:
 *   - 'fork'    — у корня есть дети: развилка подкатегорий (CategoryFork).
 *   - 'grid'    — у категории (корня без детей ИЛИ дочерней) есть товары:
 *                 сетка ProductCard.
 *   - 'product' — карточка товара.
 *
 * Вся ветвящаяся логика живёт здесь: страница `[...slug].astro` только
 * деструктурирует `Astro.props` и рендерит соответствующий блок.
 */
import type { CollectionEntry } from 'astro:content';
import type { CatalogCategory } from '../config/schemas';

export type CatalogProductEntry = CollectionEntry<'products'>;

export interface Crumb {
  name: string;
  url?: string;
}

export type CatalogPageProps =
  | {
      view: 'fork';
      category: CatalogCategory;
      subcategories: CatalogCategory[];
      crumbs: Crumb[];
    }
  | {
      view: 'grid';
      category: CatalogCategory;
      subcategory?: CatalogCategory;
      products: CatalogProductEntry[];
      crumbs: Crumb[];
    }
  | {
      view: 'product';
      category: CatalogCategory;
      subcategory?: CatalogCategory;
      product: CatalogProductEntry;
      crumbs: Crumb[];
    };

export interface CatalogPath {
  params: { slug: string };
  props: CatalogPageProps;
}

/** Сортировка: `priority` по убыванию, затем имя/название по алфавиту (ru). */
function byPriorityThenName<T>(getPriority: (v: T) => number, getName: (v: T) => string) {
  return (a: T, b: T): number => getPriority(b) - getPriority(a) || getName(a).localeCompare(getName(b), 'ru');
}

export function sortCategories(categories: CatalogCategory[]): CatalogCategory[] {
  return [...categories].sort(byPriorityThenName((c) => c.priority ?? 0, (c) => c.name));
}

export function sortProducts(products: CatalogProductEntry[]): CatalogProductEntry[] {
  return [...products].sort(byPriorityThenName((p) => p.data.priority ?? 0, (p) => p.data.title));
}

function findCategory(id: string, categories: CatalogCategory[]): CatalogCategory | undefined {
  return categories.find((c) => c.id === id);
}

function missingCategoryError(productId: string, categoryId: string): Error {
  return new Error(
    `Каталог: товар "${productId}" ссылается на несуществующую категорию "${categoryId}" ` +
      '(проверьте src/content/catalog/categories.json и поле category в frontmatter товара)',
  );
}

/** Путь категории относительно `/katalog/`: `okna` (корень) или
 *  `okna/okna-plastikovye` (дочерняя). Бросает читаемую ошибку, если у
 *  дочерней категории указан несуществующий `parent`. */
export function categoryPath(category: CatalogCategory, categories: CatalogCategory[]): string {
  if (!category.parent) return category.id;
  const parent = findCategory(category.parent, categories);
  if (!parent) {
    throw new Error(
      `Каталог: категория "${category.id}" ссылается на несуществующего родителя "${category.parent}"`,
    );
  }
  return `${parent.id}/${category.id}`;
}

/** Абсолютный href товара: `/katalog/<cat>[/<sub>]/<slug>/`. */
export function productHref(product: CatalogProductEntry, categories: CatalogCategory[]): string {
  const category = findCategory(product.data.category, categories);
  if (!category) throw missingCategoryError(product.id, product.data.category);
  return `/katalog/${categoryPath(category, categories)}/${product.id}/`;
}

const HOME_CRUMB: Crumb = { name: 'Главная', url: '/' };
const CATALOG_CRUMB: Crumb = { name: 'Каталог', url: '/katalog/' };

function buildCrumbs(
  category: CatalogCategory,
  subcategory?: CatalogCategory,
  product?: CatalogProductEntry,
): Crumb[] {
  const crumbs: Crumb[] = [HOME_CRUMB, CATALOG_CRUMB];
  const categoryHasMore = Boolean(subcategory) || Boolean(product);
  crumbs.push({ name: category.name, ...(categoryHasMore ? { url: `/katalog/${category.id}/` } : {}) });
  if (subcategory) {
    const subHasMore = Boolean(product);
    crumbs.push({
      name: subcategory.name,
      ...(subHasMore ? { url: `/katalog/${category.id}/${subcategory.id}/` } : {}),
    });
  }
  if (product) crumbs.push({ name: product.data.title });
  return crumbs;
}

/**
 * Строит все статические пути `/katalog/**` из плоского списка категорий и
 * товаров: развилки подкатегорий, сетки товаров и страницы товаров.
 * Черновики (`draft: true`) исключены полностью — не попадают ни в сетки,
 * ни в свои собственные страницы.
 *
 * Бросает читаемую ошибку, если товар ссылается на несуществующую категорию
 * (частая опечатка в frontmatter) — лучше упасть на сборке, чем молча
 * потерять товар из каталога. Тот же принцип для товара, назначенного на
 * категорию-развилку (у которой есть подкатегории): такая категория не
 * рендерит сетку товаров (только `CategoryFork`), так что товар без
 * ошибки молча выпал бы из сборки — вместо этого бросаем ошибку с id
 * товара и категории.
 */
export function buildCatalogPaths(
  categories: CatalogCategory[],
  products: CatalogProductEntry[],
): CatalogPath[] {
  const liveProducts = products.filter((p) => !p.data.draft);

  // Проверяем ссылки заранее — единая точка, где типовая опечатка в
  // `category` товара становится понятной ошибкой сборки, а не пустой
  // категорией в рантайме.
  for (const product of liveProducts) {
    if (!findCategory(product.data.category, categories)) {
      throw missingCategoryError(product.id, product.data.category);
    }
  }

  const productsByCategory = new Map<string, CatalogProductEntry[]>();
  for (const product of liveProducts) {
    const list = productsByCategory.get(product.data.category) ?? [];
    list.push(product);
    productsByCategory.set(product.data.category, list);
  }

  const paths: CatalogPath[] = [];
  const roots = sortCategories(categories.filter((c) => !c.parent));

  for (const root of roots) {
    const children = sortCategories(categories.filter((c) => c.parent === root.id));

    if (children.length > 0) {
      const orphanProducts = productsByCategory.get(root.id) ?? [];
      if (orphanProducts.length > 0) {
        const ids = orphanProducts.map((p) => p.id).join(', ');
        throw new Error(
          `Каталог: товары [${ids}] назначены на категорию "${root.id}", у которой есть подкатегории — ` +
            'укажите подкатегорию (лист дерева)',
        );
      }

      paths.push({
        params: { slug: root.id },
        props: { view: 'fork', category: root, subcategories: children, crumbs: buildCrumbs(root) },
      });

      for (const child of children) {
        const childProducts = sortProducts(productsByCategory.get(child.id) ?? []);
        paths.push({
          params: { slug: `${root.id}/${child.id}` },
          props: {
            view: 'grid',
            category: root,
            subcategory: child,
            products: childProducts,
            crumbs: buildCrumbs(root, child),
          },
        });

        for (const product of childProducts) {
          paths.push({
            params: { slug: `${root.id}/${child.id}/${product.id}` },
            props: {
              view: 'product',
              category: root,
              subcategory: child,
              product,
              crumbs: buildCrumbs(root, child, product),
            },
          });
        }
      }
    } else {
      const rootProducts = sortProducts(productsByCategory.get(root.id) ?? []);
      paths.push({
        params: { slug: root.id },
        props: { view: 'grid', category: root, products: rootProducts, crumbs: buildCrumbs(root) },
      });

      for (const product of rootProducts) {
        paths.push({
          params: { slug: `${root.id}/${product.id}` },
          props: { view: 'product', category: root, product, crumbs: buildCrumbs(root, undefined, product) },
        });
      }
    }
  }

  return paths;
}
