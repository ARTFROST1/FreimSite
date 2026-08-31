/**
 * Фид Google Merchant Center (RSS 2.0 + пространство имён g:) —
 * `<SITE.url>/google-merchant.xml`
 *
 * ТРЕЗВО О КАНАЛЕ (ревизия 2026-08). Merchant Center требует, чтобы покупатель
 * мог положить товар в корзину и оплатить онлайн, а верификация бизнеса
 * упирается в платёжный профиль — для рекламодателей из РФ этот контур
 * демонтирован с марта 2022. Отдельного режима для позаказного производства в
 * спецификации нет: слов «custom-made» / «made to order» она не знает вовсе.
 * То есть у сайта-каталога без корзины подключить фид сегодня, скорее всего,
 * НЕКУДА — проверьте это до того, как обещать канал заказчику.
 *
 * ПОЧЕМУ РОУТ ВСЁ РАВНО В СТАРТЕРЕ И ДОВЕДЁН ДО СПЕЦИФИКАЦИИ. Он ничего не
 * стоит в поддержке, но снимает работу с двух будущих развилок: появится
 * корзина — фид уже готов; появится юрлицо вне РФ или партнёрская витрина
 * (агрегаторы едят google-совместимый формат) — тоже. Держать заведомо кривой
 * фид «до лучших времён» смысла нет, поэтому поля выставлены по актуальной
 * спецификации, а не «как получится». Не нужен совсем — удалите файл.
 *
 * Товарные сниппеты в органике Google берёт НЕ отсюда, а из разметки на
 * странице (`ProductJsonLd.astro`) — аккаунт Merchant Center для них не нужен,
 * это прямо написано в документации. Два независимых канала.
 *
 * Правила те же, что у `yml.xml.ts`: только опубликованные товары с
 * распознанной ценой; без цены Merchant Center оффер не примет.
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
import { availabilityDateFrom, buildMerchantItem, offerId, xmlEscape } from '../lib/feeds';

/** Зеркало `resolveFeedPicture` из `yml.xml.ts` — правьте обе (обоснование там же). */
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
  // Считаем один раз на сборку: дата одинакова для всех офферов и обязана быть
  // реальной оценкой готовности (см. FEEDS.madeToOrder и SITE.productionLeadDays).
  const availabilityDate = FEEDS.madeToOrder ? availabilityDateFrom(new Date()) : undefined;

  const items = products
    .map((p) => {
      const price = parsePrice(p.data.price);
      if (!price) return null;
      const pictures = [p.data.image, ...p.data.slider]
        .map(resolveFeedPicture)
        .filter((src): src is string => Boolean(src));
      // `image_link` обязателен — товар без единой разрезолвленной картинки
      // Merchant Center отклонит, поэтому выбрасываем его здесь. Предупреждаем
      // вслух: пустой фид иначе неотличим от «фид ещё не наполнен», а именно
      // так регрессия и остаётся невидимой (см. шапку теста feeds.test.ts).
      if (pictures.length === 0) {
        console.warn(
          `[feeds] «${p.data.title}»: нет ни одной растровой картинки — оффер не уедет ` +
            'в Merchant Center (g:image_link обязателен; SVG не принимают)',
        );
        return null;
      }
      return buildMerchantItem({
        product: p.data,
        price,
        url: absoluteUrl(productHref(p, categories)),
        pictures,
        id: offerId(p.data, p.id),
        availabilityDate,
      });
    })
    .filter(Boolean);

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '  <channel>',
    `    <title>${xmlEscape(SITE.name)}</title>`,
    `    <link>${xmlEscape(SITE.url)}</link>`,
    `    <description>${xmlEscape(SITE.description)}</description>`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
