/**
 * YML-фид каталога — `<SITE.url>/yml.xml`
 *
 * КУДА ОН РЕАЛЬНО ПОДКЛЮЧАЕТСЯ (ревизия каналов по офиц. докам, 2026-08).
 * ------------------------------------------------------------------------
 *   ✅ Яндекс Директ — товарные кампании, динамические объявления на поиске и
 *      смарт-баннеры в РСЯ. Корзина на сайте НЕ требуется: это рекламный
 *      канал, а не витрина маркетплейса, и он работает для сайтов-каталогов
 *      без онлайн-оплаты.
 *      Требования: yandex.ru/support/direct/ru/feeds/requirements-yml
 *   ❌ Яндекс Товары (merchants.yandex.ru) — отдельная история и не лечится
 *      настройкой фида: в требованиях к магазинам дословно «На сайте есть
 *      корзина, в которую можно добавить товар и оформить заказ», а среди
 *      непринимаемых — товары, которые изготавливаются по индивидуальному
 *      заказу. Каталогу без корзины и/или производству на заказ путь туда
 *      закрыт независимо от качества фида.
 *   ❌ Вебмастер, «Услуги и предложения в поиске» — там фиксированный список
 *      вертикалей (недвижимость, вакансии, авто, курсы, услуги исполнителей,
 *      врачи, билеты, банки). Обычных товаров среди них нет.
 *
 * ⚠️  ПЕРЕПРОВЕРЬТЕ ЭТОТ СПИСОК ПЕРЕД ЗАПУСКОМ КАНАЛА: правила площадок
 * меняются, а фид, подключённый «на всякий случай», не окупается сам собой.
 *
 * Органический товарный результат в Яндексе даёт РАЗМЕТКА на страницах
 * (`ProductJsonLd.astro`), а не этот файл — это два независимых канала.
 *
 * ПОЧЕМУ БЕЗ ЦЕНЫ ОФФЕР ВЫБРАСЫВАЕТСЯ. `price` в YML обязателен и не может
 * быть нулём. Подставлять выдуманную цену нельзя ни технически (Директ
 * сверяет её с сайтом и отключает источник при расхождении), ни по-человечески.
 * Пока цены не заполнены, фид отдаёт валидный каркас без офферов и оживает сам
 * при следующей сборке — отдельный флаг «включить фиды» для этого не нужен.
 *
 * Картинки — оригиналы из реестра ассетов: Vite эмитит их в /_astro/<hash>.webp.
 * WebP Директ принимает, минимум 450×450, до 10 на оффер.
 *
 * Сборка самих офферов — `src/lib/feeds.ts` (там же тесты).
 */
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SITE, absoluteUrl } from '../config/site';
import { FEEDS } from '../config/feeds';
import { asset } from '../lib/images/registry';
import { classifyImageSource } from '../lib/images/resolve';
import { productHref } from '../lib/catalog';
import { parsePrice } from '../lib/price';
import { buildYmlOffer, offerId, xmlEscape } from '../lib/feeds';

/**
 * Значение поля-картинки → абсолютный URL, годный для фида, либо `undefined`.
 * SVG отсеиваем: его не принимают ни Директ, ни Merchant Center, а именно им
 * резолвер закрывает битую ссылку (`/images/placeholder.svg`) — плейсхолдер в
 * рекламном фиде хуже отсутствующей картинки.
 * Зеркало этой функции — в `google-merchant.xml.ts`; правьте обе.
 */
function resolveFeedPicture(value: string): string | undefined {
  const classified = classifyImageSource(value, asset);
  if (classified.kind !== 'url') {
    return classified.kind === 'svg' ? undefined : absoluteUrl(classified.img.src);
  }
  if (classified.url.endsWith('.svg')) return undefined;
  return classified.url.startsWith('http') ? classified.url : absoluteUrl(classified.url);
}

export const GET: APIRoute = async () => {
  const categories = (await getCollection('categories')).map((e) => e.data);
  const products = (await getCollection('products')).filter((p) => !p.data.draft);

  // Категории нумеруются подряд от 1: categoryId в YML — положительное целое,
  // строковые id каталога («okna») туда класть нельзя.
  const categoryIndex = new Map(categories.map((c, i) => [c.id, i + 1]));
  // Пустая категория в <categories> — не ошибка, но и не польза: Директ строит
  // по ним группировку объявлений, а группа без товаров бессмысленна.
  const usedCategoryIds = new Set(
    products.filter((p) => parsePrice(p.data.price)).map((p) => p.data.category),
  );

  const offers = products
    .map((p) => {
      const price = parsePrice(p.data.price);
      if (!price) return null;
      const categoryId = categoryIndex.get(p.data.category);
      if (!categoryId) return null;
      // Фильтруем ДО среза: иначе нерезолвившийся ключ съедал бы слот из десяти.
      const pictures = [p.data.image, ...p.data.slider]
        .map(resolveFeedPicture)
        .filter((src): src is string => Boolean(src));
      return buildYmlOffer({
        product: p.data,
        price,
        url: absoluteUrl(productHref(p, categories)),
        pictures,
        categoryId,
        id: offerId(p.data, p.id),
      });
    })
    .filter(Boolean);

  // Формат даты строго YYYY-MM-DD hh:mm — иначе Директ отклоняет файл целиком.
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<yml_catalog date="${date}">`,
    '  <shop>',
    // Порядок блоков внутри <shop> задан спецификацией:
    // name/company/url → currencies → categories → offers.
    `    <name>${xmlEscape(SITE.name)}</name>`,
    `    <company>${xmlEscape(SITE.legalName)}</company>`,
    `    <url>${xmlEscape(SITE.url)}</url>`,
    '    <currencies>',
    `      <currency id="${xmlEscape(FEEDS.ymlCurrencyId)}" rate="1"/>`,
    '    </currencies>',
    // Список ПЛОСКИЙ, без атрибута parentId, хотя дерево каталога двухуровневое:
    // parentId обязан ссылаться на категорию, которая тоже есть в этом списке, а
    // мы оставляем только непустые. Плоский список спецификация допускает, и на
    // группировку объявлений это не влияет — товар всё равно привязан к листу.
    '    <categories>',
    ...categories
      .filter((c) => usedCategoryIds.has(c.id))
      .map((c) => `      <category id="${categoryIndex.get(c.id)}">${xmlEscape(c.name)}</category>`),
    '    </categories>',
    '  <offers>',
    ...offers,
    '  </offers>',
    '  </shop>',
    '</yml_catalog>',
    '',
  ].join('\n');

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
