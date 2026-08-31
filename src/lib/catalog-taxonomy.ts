/**
 * Техническая привязка категорий каталога к внешним товарным таксономиям.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ МОДУЛЕМ, А НЕ ПОЛЕМ В categories.json. Это не контент:
 * заказчик не должен видеть в CMS-портале поле «ID категории Google» и не
 * может его осмысленно заполнить. Категории каталога меняются раз в год, коды
 * таксономии — ещё реже, поэтому карта живёт в коде рядом с потребителями
 * (`src/lib/feeds.ts` → `yml.xml.ts`, `google-merchant.xml.ts`).
 *
 * ИСТОЧНИК КОДОВ GOOGLE. Официальный файл
 * `https://www.google.com/basepages/producttype/taxonomy-with-ids.<locale>.txt`
 * (напр. `taxonomy-with-ids.ru-RU.txt`). Атрибут `google_product_category`
 * рекомендованный, а не обязательный: без него Google классифицирует товар
 * сам и регулярно мажет мимо. Но НЕВЕРНЫЙ код хуже отсутствующего — его
 * Google примет молча и разложит товар не туда, поэтому `googleCategoryId`
 * необязателен: заполняйте его только после сверки со свежим файлом, а дату
 * сверки пишите в комментарии рядом с записью.
 *
 * `typePrefix` — элемент YML-фида Яндекс Директа: ТИП товара без модели
 * («Окно», не «Окно „Стандарт“»). Директ строит из него заголовок
 * динамического объявления и группировку в товарной галерее. Внешней сверки
 * не требует — это ваш собственный текст.
 */

export interface CategoryTaxonomy {
  /**
   * Числовой ID Google product taxonomy. Необязателен: пока код не сверен с
   * официальным файлом, элемент `g:google_product_category` не эмитится
   * вовсе (см. шапку модуля).
   */
  googleCategoryId?: number;
  /** Путь той же ветки — уходит в `g:product_type` (свой рубрикатор, любой текст). */
  googleCategoryPath: string;
  /** `<typePrefix>` для YML: тип товара в единственном числе. */
  ymlTypePrefix: string;
}

/**
 * Ключ — `id` категории из `src/content/catalog/categories.json`.
 *
 * ⚠️  ЗАПИСИ НИЖЕ — ДЕМО под демо-каталог стартера. Замените их на категории
 * своего проекта. Привязывать нужно ЛИСТЬЯ дерева (категории, к которым
 * реально привязаны товары), а не развилки: в фид уезжает `product.category`.
 * Категория без записи здесь просто не получит эти поля — фид остаётся
 * валидным, поэтому карта не обязана покрывать всё дерево. Забытая привязка
 * ловится тестом `src/lib/__tests__/feeds.test.ts`.
 */
export const CATEGORY_TAXONOMY: Record<string, CategoryTaxonomy> = {
  'okna-plastikovye': {
    // googleCategoryId: заполнить после сверки с taxonomy-with-ids.<locale>.txt.
    googleCategoryPath: 'Оборудование > Строительные материалы > Окна',
    ymlTypePrefix: 'Окно',
  },
  dveri: {
    // googleCategoryId: заполнить после сверки с taxonomy-with-ids.<locale>.txt.
    googleCategoryPath: 'Оборудование > Строительные материалы > Двери',
    ymlTypePrefix: 'Дверь',
  },
};

export function taxonomyFor(categoryId: string): CategoryTaxonomy | undefined {
  return CATEGORY_TAXONOMY[categoryId];
}
