/**
 * Тесты товарных фидов.
 *
 * ЗАЧЕМ ОНИ ВООБЩЕ НУЖНЫ, ЕСЛИ ФИД «РАБОТАЕТ». Пока цены в каталоге не
 * заполнены, оба фида на проде ПУСТЫ — валидный каркас без единого оффера.
 * «Работает» в такой ситуации никак не наблюдается: поймать регрессию нечем
 * ровно до того дня, когда цены появятся и фид уедет в рекламный кабинет уже
 * сломанным. Отсюда набор ассертов: обязательные по спецификации поля,
 * честность наличия/срока и отсутствие полей, которые мы убрали намеренно.
 *
 * Фикстура ниже — демо-товар стартера. Заменяя каталог, замените и её.
 */
import { describe, it, expect } from 'vitest';
import {
  availabilityDateFrom,
  brandOf,
  buildMerchantItem,
  buildYmlOffer,
  offerId,
  MAX_PICTURES,
  MAX_ADDITIONAL_IMAGES,
  xmlEscape,
  type FeedProduct,
} from '../feeds';
import { SITE } from '../../config/site';
import { FEEDS, merchantAvailability, salesNotes } from '../../config/feeds';
import { CATEGORY_TAXONOMY, taxonomyFor } from '../catalog-taxonomy';

const PRODUCT: FeedProduct = {
  title: 'Окно «Стандарт»',
  shortDescription: 'Двухкамерное окно для квартиры — тепло и тихо.',
  metaDescription: 'Окно «Стандарт»: двухкамерный стеклопакет, монтаж за день',
  category: 'okna-plastikovye',
  article: 'W-001',
  specs: [
    { label: 'Профиль', value: 'Пятикамерный, 70 мм' },
    { label: 'Материал профиля', value: 'ПВХ с армированием' },
    { label: 'Материал уплотнителя', value: 'EPDM' },
    { label: 'Размер', value: '1300/1400' },
  ],
};

const BASE = {
  product: PRODUCT,
  price: 12_500,
  url: 'https://example.com/katalog/okna/okna-plastikovye/okno-standart/',
  pictures: ['https://example.com/_astro/okno-01.webp', 'https://example.com/_astro/okno-02.webp'],
};

const yml = (over: Partial<Parameters<typeof buildYmlOffer>[0]> = {}) =>
  buildYmlOffer({ ...BASE, categoryId: 1, id: 'W-001', ...over });

const merchant = (over: Partial<Parameters<typeof buildMerchantItem>[0]> = {}) =>
  buildMerchantItem({ ...BASE, id: 'W-001', availabilityDate: '2026-09-17T00:00:00Z', ...over });

describe('YML-оффер (Яндекс Директ)', () => {
  it('содержит все обязательные по спецификации элементы упрощённого типа', () => {
    const xml = yml();
    // Обязательные: id, name, categoryId, url, price (+ currencyId при цене).
    expect(xml).toContain('<offer id="W-001"');
    expect(xml).toContain('<name>Окно «Стандарт»</name>');
    expect(xml).toContain('<categoryId>1</categoryId>');
    expect(xml).toContain(`<url>${BASE.url}</url>`);
    expect(xml).toContain('<price>12500</price>');
    expect(xml).toContain(`<currencyId>${FEEDS.ymlCurrencyId}</currencyId>`);
  });

  it('порядок элементов соответствует спецификации — часть парсеров к нему чувствительна', () => {
    const order = [
      '<url>',
      '<price>',
      '<currencyId>',
      '<categoryId>',
      '<picture>',
      '<name>',
      '<vendor>',
      '<vendorCode>',
      '<description>',
      // Товару со склада срок обещать нечего — элемента там нет вовсе.
      ...(FEEDS.madeToOrder ? ['<sales_notes>'] : []),
    ];
    const positions = order.map((tag) => yml().indexOf(tag));
    expect(positions.every((p) => p !== -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('срок изготовления назван в sales_notes — в YML это единственное место для него', () => {
    const notes = salesNotes();
    if (FEEDS.madeToOrder) {
      expect(notes).toContain(String(SITE.productionLeadDays));
      expect(yml()).toContain(`<sales_notes>${xmlEscape(notes)}</sales_notes>`);
    } else {
      // Товар со склада: обещать срок нечего — элемент не эмитим вовсе.
      expect(yml()).not.toContain('<sales_notes>');
    }
  });

  it('утверждения о гарантии и стране производства эмитятся только по конфигу', () => {
    const xml = yml();
    expect(xml.includes('<manufacturer_warranty>')).toBe(FEEDS.manufacturerWarranty);
    expect(xml.includes('<country_of_origin>')).toBe(Boolean(FEEDS.countryOfOrigin));
  });

  it('артикул уходит в vendorCode, а без артикула элемент не эмитится', () => {
    expect(yml()).toContain('<vendorCode>W-001</vendorCode>');
    const noArticle = yml({ product: { ...PRODUCT, article: undefined }, id: 'okno-standart' });
    expect(noArticle).not.toContain('<vendorCode>');
    expect(noArticle).toContain('<offer id="okno-standart"');
  });

  it('характеристики уходят в param, а тип товара — в typePrefix', () => {
    const xml = yml();
    expect(xml).toContain('<param name="Профиль">Пятикамерный, 70 мм</param>');
    expect(xml).toContain(
      `<typePrefix>${xmlEscape(taxonomyFor(PRODUCT.category)!.ymlTypePrefix)}</typePrefix>`,
    );
  });

  it('vendor — бренд товара, а без brands фолбэк на имя сайта', () => {
    expect(yml()).toContain(`<vendor>${SITE.name}</vendor>`);
    const reseller = yml({ product: { ...PRODUCT, brands: ['VEKA', 'REHAU'] } });
    expect(reseller).toContain('<vendor>VEKA, REHAU</vendor>');
  });

  it('картинок не больше десяти — лимит Директа', () => {
    const many = Array.from({ length: 15 }, (_, i) => `https://example.com/_astro/p${i}.webp`);
    const count = (yml({ pictures: many }).match(/<picture>/g) ?? []).length;
    expect(count).toBe(MAX_PICTURES);
  });

  it('экранирует спецсимволы в тексте товара', () => {
    const xml = yml({ product: { ...PRODUCT, title: 'Окно "Комфорт" & <Плюс>' } });
    expect(xml).toContain('<name>Окно &quot;Комфорт&quot; &amp; &lt;Плюс&gt;</name>');
    expect(xml).not.toMatch(/<name>[^<]*<(?!\/name)/);
  });
});

describe('Google Merchant — item', () => {
  it('содержит все обязательные атрибуты спецификации', () => {
    const xml = merchant();
    const required = [
      'g:id',
      'g:title',
      'g:description',
      'g:link',
      'g:image_link',
      'g:availability',
      'g:price',
      'g:brand',
    ];
    for (const tag of required) {
      expect(xml, `нет обязательного ${tag}`).toContain(`<${tag}>`);
    }
    expect(xml).toContain(`<g:price>12500.00 ${FEEDS.currency}</g:price>`);
    expect(xml).toContain(`<g:brand>${SITE.name}</g:brand>`);
  });

  it('наличие честное: preorder всегда сопровождается availability_date — иначе оффер отклоняют', () => {
    const xml = merchant();
    expect(xml).toContain(`<g:availability>${merchantAvailability()}</g:availability>`);
    if (merchantAvailability() === 'preorder') {
      expect(xml).toMatch(/<g:availability_date>\d{4}-\d{2}-\d{2}T[\d:]+Z<\/g:availability_date>/);
      // Заявить склад при производстве на заказ — прямое расхождение с
      // посадочной страницей, а это повод для блокировки.
      expect(xml).not.toContain('in_stock');
    }
  });

  it('g:brand — бренд товара, а без brands фолбэк на имя сайта (симметрия с разметкой)', () => {
    expect(merchant()).toContain(`<g:brand>${SITE.name}</g:brand>`);
    const reseller = merchant({ product: { ...PRODUCT, brands: ['VEKA', 'REHAU'] } });
    expect(reseller).toContain('<g:brand>VEKA, REHAU</g:brand>');
    // Бренд обязан совпадать с тем, что уходит в ProductJsonLd.
    expect(brandOf({ ...PRODUCT, brands: ['VEKA', 'REHAU'] })).toBe('VEKA, REHAU');
    expect(brandOf(PRODUCT)).toBe(SITE.name);
  });

  it('availability_date проставляется сама, даже если её забыли передать', () => {
    // Инвариант «preorder ⇒ availability_date» держится внутри билдера:
    // потребитель не может выпустить оффер, который Google отклонит.
    const xml = buildMerchantItem({ ...BASE, id: 'W-001' });
    if (merchantAvailability() === 'preorder') {
      expect(xml).toMatch(/<g:availability_date>\d{4}-\d{2}-\d{2}T[\d:]+Z<\/g:availability_date>/);
    } else {
      expect(xml).not.toContain('<g:availability_date>');
    }
  });

  it('товар без картинок — ошибка сборки, а не молча битый оффер', () => {
    // g:image_link обязателен: такой товар обязан быть отфильтрован раньше
    // (роут это делает), поэтому здесь его появление — баг потребителя.
    expect(() => merchant({ pictures: [] })).toThrow(/g:image_link/);
  });

  it('идентификатор товара закрыт парой brand + mpn, identifier_exists не нужен', () => {
    const xml = merchant();
    expect(xml).toContain('<g:mpn>W-001</g:mpn>');
    expect(xml).not.toContain('identifier_exists');
  });

  it('товар без артикула заявляет identifier_exists — иначе оффер отклонят', () => {
    // `article` в стартере опционален, то есть это ДЕФОЛТНОЕ состояние шаблона:
    // ни GTIN, ни MPN у товара нет физически, и об этом надо сказать вслух.
    const xml = merchant({ product: { ...PRODUCT, article: undefined }, id: 'okno-standart' });
    expect(xml).not.toContain('<g:mpn>');
    expect(xml).toContain('<g:identifier_exists>no</g:identifier_exists>');
  });

  it('категория Google берётся из таксономии, а не угадывается', () => {
    const xml = merchant();
    const taxonomy = taxonomyFor(PRODUCT.category)!;
    // Разделитель уровней «>» в XML обязан быть экранирован — парсер Google
    // получит исходный путь после разбора документа.
    expect(xml).toContain(`<g:product_type>${xmlEscape(taxonomy.googleCategoryPath)}</g:product_type>`);
    // Числовой код эмитится ТОЛЬКО когда он сверен и проставлен: неверный код
    // Google примет молча и разложит товар не туда (см. catalog-taxonomy.ts).
    expect(xml.includes('<g:google_product_category>')).toBe(Boolean(taxonomy.googleCategoryId));
  });

  it('товар из категории без таксономии остаётся валидным оффером', () => {
    const xml = merchant({ product: { ...PRODUCT, category: 'no-such-category' } });
    expect(xml).not.toContain('<g:product_type>');
    expect(xml).not.toContain('<g:google_product_category>');
    expect(xml).toContain('<g:id>W-001</g:id>');
  });

  it('material собирается из характеристик по меткам из конфига', () => {
    expect(merchant()).toContain('<g:material>ПВХ с армированием, EPDM</g:material>');
  });

  it('характеристики уходят в product_detail по одной на тройку полей', () => {
    const xml = merchant();
    expect((xml.match(/<g:product_detail>/g) ?? []).length).toBe(PRODUCT.specs!.length);
    expect(xml).toContain('<g:attribute_name>Размер</g:attribute_name>');
    expect(xml).toContain('<g:attribute_value>1300/1400</g:attribute_value>');
  });

  it('первая картинка — основная, остальные дополнительные и не больше десяти', () => {
    const many = Array.from({ length: 15 }, (_, i) => `https://example.com/_astro/p${i}.webp`);
    const xml = merchant({ pictures: many });
    expect(xml).toContain('<g:image_link>https://example.com/_astro/p0.webp</g:image_link>');
    expect((xml.match(/<g:additional_image_link>/g) ?? []).length).toBe(MAX_ADDITIONAL_IMAGES);
  });

  it('description предпочитает metaDescription, а без него берёт короткое описание', () => {
    expect(merchant()).toContain(`<g:description>${PRODUCT.metaDescription}</g:description>`);
    const noMeta = merchant({ product: { ...PRODUCT, metaDescription: undefined } });
    expect(noMeta).toContain(`<g:description>${PRODUCT.shortDescription}</g:description>`);
  });
});

describe('вспомогательные', () => {
  it('offerId — артикул, иначе slug', () => {
    expect(offerId(PRODUCT, 'okno-standart')).toBe('W-001');
    expect(offerId({ ...PRODUCT, article: undefined }, 'okno-standart')).toBe('okno-standart');
  });

  it('availabilityDateFrom сдвигает дату на срок изготовления и отдаёт ISO 8601', () => {
    const start = new Date('2026-08-18T12:00:00Z');
    const expected = new Date(start.getTime() + SITE.productionLeadDays * 86_400_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    expect(availabilityDateFrom(start)).toBe(expected);
    expect(availabilityDateFrom(start)).not.toMatch(/\.\d{3}Z$/); // миллисекунды Google не ждёт
  });

  it('каждая категория с товарами имеет запись в таксономии', async () => {
    // Ловим забытую привязку при добавлении категории: без неё товар уедет в
    // фид без product_type, и Google классифицирует его сам. Читаем
    // фронтматтер файлами, а не через astro:content: этот модуль обязан
    // подниматься в vitest (см. шапку src/lib/feeds.ts).
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../../content/products/', import.meta.url);
    const used = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const source = readFileSync(new URL(file, dir), 'utf-8');
      if (/^draft:\s*true/m.test(source)) continue;
      const category = source.match(/^category:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1];
      if (category) used.add(category);
    }
    expect(used.size, 'в демо-каталоге нет ни одного опубликованного товара').toBeGreaterThan(0);
    for (const id of used) {
      expect(CATEGORY_TAXONOMY[id], `нет таксономии для категории «${id}»`).toBeDefined();
    }
  });
});
