/**
 * Сборка офферов товарных фидов — YML (Яндекс Директ) и RSS+g: (Google
 * Merchant Center).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ МОДУЛЕМ. Роуты `src/pages/yml.xml.ts` и
 * `google-merchant.xml.ts` импортируют `astro:content` на верхнем уровне —
 * такой модуль не поднимается в vitest. Пока логика жила в них, фиды нельзя
 * было покрыть тестами вообще: единственное, что проверялось, — экранирование.
 * Здесь функции чистые (на вход — данные товара и уже разрезолвленные URL
 * картинок), поэтому регрессию ловим до сборки, а не после выкатки.
 *
 * Ответственность роутов после выноса: собрать коллекции, разрезолвить
 * картинки через реестр ассетов и обернуть офферы в документ.
 *
 * Обоснование каналов и полей — в doc-комментарии соответствующего роута и в
 * `src/config/feeds.ts`; здесь только механика.
 */
import { SITE } from '../config/site';
import { FEEDS, merchantAvailability, salesNotes } from '../config/feeds';
import { taxonomyFor } from './catalog-taxonomy';

/** Директ ограничивает число картинок в оффере десятью. */
export const MAX_PICTURES = 10;
/** `<param>` сверх этого числа Директ игнорирует — режем на нашей стороне. */
export const MAX_PARAMS = 10;
/** Google принимает до 10 дополнительных картинок сверх основной. */
export const MAX_ADDITIONAL_IMAGES = 10;
/** `product_detail` — до 100 характеристик на товар. */
export const MAX_PRODUCT_DETAILS = 100;

export function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Данные товара, которых достаточно обоим фидам.
 *
 * Это НАДМНОЖЕСТВО `productSchema` стартера: `article` и `specs` — поля,
 * которые проект добавляет в `src/config/schemas.ts` под свой каталог
 * (сквозной артикул из CRM и характеристики парами «метка → значение»).
 * Оба необязательны: без них фид остаётся валидным, просто беднее (см.
 * docs/recipes/product-feeds.md).
 */
export interface FeedProduct {
  title: string;
  shortDescription: string;
  metaDescription?: string;
  category: string;
  article?: string;
  /** Бренд(ы) товара. Пусто → брендом считается сам сайт (см. `brandOf`). */
  brands?: string[];
  specs?: { label: string; value: string }[];
}

export interface FeedOfferInput {
  product: FeedProduct;
  /** Разобранная цена (> 0). Товары без цены до сборки оффера не доходят. */
  price: number;
  /** Абсолютный URL карточки товара. */
  url: string;
  /** Абсолютные URL картинок, первая — обложка. Уже отфильтрованы от пустых. */
  pictures: string[];
}

/** Идентификатор оффера: сквозной артикул, иначе slug. */
export function offerId(product: FeedProduct, slug: string): string {
  return product.article ?? slug;
}

/**
 * Бренд товара для `<vendor>` и `g:brand` с фолбэком на имя сайта.
 *
 * Ровно то же правило, что у `brand` в `ProductJsonLd.astro`: у производителя
 * товарного мультибренда нет, и брендом выступает он сам, а перепродавец
 * заполняет `brands` во фронтматтере. Симметрия обязательна — разный бренд на
 * странице и в фиде поисковик читает как расхождение с посадочной страницей.
 */
export function brandOf(product: FeedProduct): string {
  return product.brands?.length ? product.brands.join(', ') : SITE.name;
}

/**
 * Один `<offer>` YML. Порядок элементов — по спецификации формата: часть
 * парсеров Яндекса к нему чувствительна.
 */
export function buildYmlOffer(input: FeedOfferInput & { id: string; categoryId: number }): string {
  const { product, price, url, pictures, categoryId, id } = input;
  const taxonomy = taxonomyFor(product.category);
  const params = (product.specs ?? []).slice(0, MAX_PARAMS);
  const notes = salesNotes();
  return [
    // available="true" здесь НЕ враньё даже для производства на заказ: в YML
    // атрибут означает «товар можно заказать», а не «лежит на складе». Срок
    // изготовления называем в <sales_notes> — единственном месте формата, где
    // его можно указать (аналога PreOrder в YML нет).
    `    <offer id="${xmlEscape(id)}" available="true">`,
    `      <url>${xmlEscape(url)}</url>`,
    `      <price>${price}</price>`,
    `      <currencyId>${xmlEscape(FEEDS.ymlCurrencyId)}</currencyId>`,
    `      <categoryId>${categoryId}</categoryId>`,
    ...pictures.slice(0, MAX_PICTURES).map((src) => `      <picture>${xmlEscape(src)}</picture>`),
    `      <name>${xmlEscape(product.title)}</name>`,
    `      <vendor>${xmlEscape(brandOf(product))}</vendor>`,
    ...(product.article ? [`      <vendorCode>${xmlEscape(product.article)}</vendorCode>`] : []),
    `      <description>${xmlEscape(product.shortDescription)}</description>`,
    ...(notes ? [`      <sales_notes>${xmlEscape(notes)}</sales_notes>`] : []),
    // Оба элемента ниже — утверждения о товаре, поэтому эмитятся только когда
    // проект их сознательно включил в src/config/feeds.ts.
    ...(FEEDS.manufacturerWarranty ? ['      <manufacturer_warranty>true</manufacturer_warranty>'] : []),
    ...(FEEDS.countryOfOrigin
      ? [`      <country_of_origin>${xmlEscape(FEEDS.countryOfOrigin)}</country_of_origin>`]
      : []),
    ...(taxonomy ? [`      <typePrefix>${xmlEscape(taxonomy.ymlTypePrefix)}</typePrefix>`] : []),
    ...params.map((s) => `      <param name="${xmlEscape(s.label)}">${xmlEscape(s.value)}</param>`),
    '    </offer>',
  ].join('\n');
}

/**
 * Один `<item>` фида Google Merchant Center.
 *
 * ИНВАРИАНТ: `availability: preorder` ВСЕГДА сопровождается
 * `availability_date` — без даты Google отклоняет такой оффер. Поэтому
 * `availabilityDate` необязателен во входе, но не в выводе: не передали —
 * посчитаем сами от текущего момента. Забыть дату, добавляя нового
 * потребителя, здесь нельзя; цена этого — единственное обращение к часам в
 * модуле, поэтому дату лучше передавать снаружи (роут считает её один раз на
 * всю сборку, чтобы она была одинаковой во всех офферах).
 *
 * Бросает, если `pictures` пуст: `g:image_link` обязателен, и товар без
 * картинок обязан быть отфильтрован ДО сборки оффера.
 */
export function buildMerchantItem(
  input: FeedOfferInput & { id: string; availabilityDate?: string },
): string {
  const { product, price, url, pictures, id } = input;
  if (pictures.length === 0) {
    throw new Error(
      `buildMerchantItem: у товара «${product.title}» (${id}) нет ни одной картинки, ` +
        'а g:image_link обязателен — отфильтруйте такие товары до сборки оффера ' +
        '(как это делает src/pages/google-merchant.xml.ts)',
    );
  }
  const [main, ...rest] = pictures;
  const taxonomy = taxonomyFor(product.category);
  const specs = product.specs ?? [];
  const availability = merchantAvailability();
  const availabilityDate =
    availability === 'preorder' ? (input.availabilityDate ?? availabilityDateFrom(new Date())) : undefined;
  const material = specs
    .filter((s) => FEEDS.materialLabels.some((l) => s.label.toLowerCase().includes(l)))
    .map((s) => s.value)
    .join(', ');
  return [
    '    <item>',
    `      <g:id>${xmlEscape(id)}</g:id>`,
    `      <g:title>${xmlEscape(product.title)}</g:title>`,
    `      <g:description>${xmlEscape(product.metaDescription ?? product.shortDescription)}</g:description>`,
    `      <g:link>${xmlEscape(url)}</g:link>`,
    `      <g:image_link>${xmlEscape(main!)}</g:image_link>`,
    ...rest
      .slice(0, MAX_ADDITIONAL_IMAGES)
      .map((src) => `      <g:additional_image_link>${xmlEscape(src)}</g:additional_image_link>`),
    `      <g:availability>${availability}</g:availability>`,
    ...(availabilityDate
      ? [`      <g:availability_date>${xmlEscape(availabilityDate)}</g:availability_date>`]
      : []),
    `      <g:price>${price.toFixed(2)} ${FEEDS.currency}</g:price>`,
    '      <g:condition>new</g:condition>',
    `      <g:brand>${xmlEscape(brandOf(product))}</g:brand>`,
    // ИДЕНТИФИКАТОР ТОВАРА — обязательное требование спецификации, и закрыть
    // его можно двумя способами. Есть артикул — пара «brand + mpn» его
    // закрывает (собственный артикул в роли MPN легален для производителя), и
    // тогда `identifier_exists` не нужен. Артикула нет — GTIN и MPN отсутствуют
    // физически, и об этом надо СКАЗАТЬ: молчание Merchant Center читает как
    // «идентификатор потерян» и отклоняет оффер, а не как «его не существует».
    ...(product.article
      ? [`      <g:mpn>${xmlEscape(product.article)}</g:mpn>`]
      : ['      <g:identifier_exists>no</g:identifier_exists>']),
    ...(taxonomy?.googleCategoryId
      ? [`      <g:google_product_category>${taxonomy.googleCategoryId}</g:google_product_category>`]
      : []),
    ...(taxonomy
      ? [`      <g:product_type>${xmlEscape(taxonomy.googleCategoryPath)}</g:product_type>`]
      : []),
    ...(material ? [`      <g:material>${xmlEscape(material)}</g:material>`] : []),
    ...specs.slice(0, MAX_PRODUCT_DETAILS).map((s) =>
      [
        '      <g:product_detail>',
        '        <g:section_name>Характеристики</g:section_name>',
        `        <g:attribute_name>${xmlEscape(s.label)}</g:attribute_name>`,
        `        <g:attribute_value>${xmlEscape(s.value)}</g:attribute_value>`,
        '      </g:product_detail>',
      ].join('\n'),
    ),
    '    </item>',
  ].join('\n');
}

/**
 * Дата готовности для `g:availability_date`: `availability: preorder`
 * ОБЯЗЫВАЕТ её указать, иначе Google отклоняет оффер. Считается от момента
 * сборки плюс типовой срок изготовления (`SITE.productionLeadDays`) —
 * пересчитывается при каждом деплое, поэтому не протухает.
 */
export function availabilityDateFrom(now: Date): string {
  return new Date(now.getTime() + SITE.productionLeadDays * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}
