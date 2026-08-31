/**
 * ============================================================================
 *  FEEDS CONFIG — факты о товаре, которые сайт утверждает во внешних каналах.
 * ----------------------------------------------------------------------------
 *  Отсюда читают ВСЕ товарные каналы проекта:
 *    • /yml.xml              — фид Яндекс Директа (src/pages/yml.xml.ts)
 *    • /google-merchant.xml  — фид Google Merchant (src/pages/google-merchant.xml.ts)
 *    • Product JSON-LD       — src/components/seo/ProductJsonLd.astro
 *
 *  ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ SITE. `config/site.ts` — про бренд и витрину.
 *  Здесь — утверждения, за которые отвечают перед поисковиком и покупателем:
 *  «товар в наличии», «гарантия производителя», «возврат не предусмотрен».
 *  Каждое из них должно быть правдой на всех трёх каналах сразу, иначе
 *  расхождение между сайтом и фидом становится поводом отключить источник
 *  (Директ) или отклонить оффер (Merchant Center). Один файл — одна правда.
 *
 *  ⚠️  ЭТО НЕ CMS-РЕДАКТИРУЕМО. Здесь не тексты, а юридически значимые
 *  утверждения; менять их должен разработчик по подтверждению заказчика.
 *
 *  Происхождение: вынесено из боевого проекта и обезличено.
 * ============================================================================
 */
import { SITE } from './site';

export interface FeedsConfig {
  /**
   * ГЛАВНЫЙ ПЕРЕКЛЮЧАТЕЛЬ ЧЕСТНОСТИ. `true` — товар изготавливается ПОСЛЕ
   * заказа (мебель, окна, двери, любое производство по размерам). Тогда:
   *   • Merchant Center получает `availability: preorder` + обязательную
   *     `availability_date` (см. SITE.productionLeadDays);
   *   • JSON-LD получает `schema.org/PreOrder`;
   *   • YML — срок изготовления в `<sales_notes>` (аналога PreOrder в YML нет).
   * `false` — товар отгружается со склада: `in_stock` / `InStock`, дата
   * готовности не эмитится.
   *
   * Соврать здесь дорого: `in_stock` при сроке в месяц — прямое расхождение с
   * посадочной страницей, а это повод для блокировки оффера.
   */
  madeToOrder: boolean;

  /**
   * Код валюты для `<currencyId>` YML. У Яндекса это СВОЙ справочник, а не
   * ISO 4217: рубль там `RUR`. Не путать с `currency` ниже.
   */
  ymlCurrencyId: string;

  /**
   * ISO 4217 — уходит в `g:price` Merchant Center и в `priceCurrency` JSON-LD.
   * Для рубля это `RUB` (в отличие от YML-кода выше).
   */
  currency: string;

  /**
   * `<country_of_origin>` YML — страна производства ЧЕЛОВЕЧЕСКИМ названием на
   * языке фида («Россия», «Беларусь»). Пусто — элемент не эмитится: пустая
   * строка честнее выдуманной страны.
   */
  countryOfOrigin: string;

  /**
   * ISO 3166-1 alpha-2 — регион доставки (`shippingDetails`) и страна
   * действия политики возврата в JSON-LD. Это КОД, не название.
   */
  countryCode: string;

  /**
   * `<manufacturer_warranty>` YML. `true` ставить, только если гарантию даёт
   * ПРОИЗВОДИТЕЛЬ и производитель — вы. Перепродавец с гарантией магазина
   * обязан оставить `false`: элемент тогда просто не эмитится.
   */
  manufacturerWarranty: boolean;

  /**
   * Метки характеристик, из которых собирается `g:material` Merchant Center
   * (сравнение по вхождению, регистронезависимо). Материал — отдельный
   * атрибут спецификации, а не просто ещё одна характеристика: Google
   * использует его в фильтрах товарной выдачи.
   *
   * Держите список УЗКИМ и добавляйте метки под свою номенклатуру: попавшая
   * сюда лишняя метка склеивает в `material` то, что материалом не является.
   * Мебели, например, подходит `['материал', 'обивка', 'каркас']`.
   */
  materialLabels: string[];

  /**
   * Политика возврата для `hasMerchantReturnPolicy` в JSON-LD.
   *
   * Дефолт `MerchantReturnNotPermitted` — под режим `madeToOrder: true`:
   * товар надлежащего качества, изготовленный по индивидуальному заказу,
   * обмену и возврату не подлежит (в РФ — перечень, утв. ПП РФ № 2463).
   * Магазину со склада тут место `MerchantReturnFiniteReturnWindow` и
   * реальное число дней в `merchantReturnDays`.
   */
  returnPolicy: {
    /** ISO 3166-1 alpha-2 страны, где действует политика. */
    applicableCountry: string;
    /** URL значения schema.org (`https://schema.org/MerchantReturn…`). */
    returnPolicyCategory: string;
    /** Срок возврата в днях. Эмитится только для FiniteReturnWindow. */
    merchantReturnDays: number;
  };
}

export const FEEDS: FeedsConfig = {
  madeToOrder: true,
  ymlCurrencyId: 'RUR',
  currency: 'RUB',
  countryOfOrigin: 'Россия',
  countryCode: 'RU',
  // ЗАПОЛНИТЬ ОСОЗНАННО: см. doc-комментарий выше — по умолчанию не заявляем.
  manufacturerWarranty: false,
  materialLabels: ['материал'],
  returnPolicy: {
    applicableCountry: 'RU',
    returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    merchantReturnDays: 0,
  },
};

/** Значение `g:availability` Merchant Center для текущего режима. */
export function merchantAvailability(): 'preorder' | 'in_stock' {
  return FEEDS.madeToOrder ? 'preorder' : 'in_stock';
}

/**
 * Значение `availability` для schema.org.
 *
 * `PreOrder` — самое честное из того, что понимают ОБА поисковика.
 * `MadeToOrder` в schema.org есть, но Google его НЕ распознаёт (ошибка в
 * валидаторе и ноль пользы), поэтому не используем.
 */
export function schemaAvailability(): string {
  return FEEDS.madeToOrder ? 'https://schema.org/PreOrder' : 'https://schema.org/InStock';
}

/**
 * Текст `<sales_notes>` YML. В формате это ЕДИНСТВЕННОЕ место, куда можно
 * положить срок изготовления: `available="true"` в YML означает «товар можно
 * заказать», а не «лежит на складе», и аналога PreOrder там нет.
 *
 * Пустая строка → элемент не эмитится (товар со склада).
 */
export function salesNotes(): string {
  if (!FEEDS.madeToOrder) return '';
  return `Изготовление на заказ, ${SITE.productionLeadDays} дней; цена и срок фиксируются в договоре`;
}
