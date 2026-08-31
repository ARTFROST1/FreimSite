/**
 * OG-кадр (`og:image` + width/height/alt) для любой страницы, у которой
 * есть обложка из `src/assets/**`: карточка каталога, статья блога и т.д.
 *
 * ЗАЧЕМ. `og:image:width`/`height` — подсказка парсеру: по ней соцсеть решает,
 * рисовать крупную карточку или мелкую иконку, ещё ДО того как скачает файл.
 * Соблазн — попросить у Astro фиксированный кадр (например 1200×630) и эти же
 * числа записать в мету. Но сервис картинок Astro НЕ увеличивает изображение:
 * из обложки 1024×768 выйдет 1024×630, из 683×1024 — 683×630. Если в мете
 * всё равно стоят константы, парсер получает файл меньше заявленного и на
 * расхождении гасит превью — ссылка «не подгружается», а typecheck и сборка
 * об этом молчат.
 *
 * Поэтому здесь честно: в мету идёт РЕЗУЛЬТИРУЮЩИЙ размер кадра (усечённый по
 * каждой оси не больше исходника), а не запрошенный. Правило усечения
 * детерминированное, поэтому `scripts/__tests__/og-images.test.ts` может
 * пересчитать его независимо и сверить с тем, что реально легло в `dist/`.
 *
 * Пропорция 1.91:1 (рекомендация соцсетей) намеренно НЕ навязывается: чтобы
 * её выдержать на вертикальной обложке, пришлось бы обрезать половину товара
 * или иллюстрации, а крупную карточку соцсети рисуют для любого кадра от
 * 600×315 — этого достаточно.
 */
import { getImage } from 'astro:assets';
import { asset } from './images/registry';
import { classifyImageSource } from './images/resolve';
import { SITE } from '../config/site';

export interface OgFrame {
  src: string;
  width: number;
  height: number;
}

/** Целевой запрос к сервису картинок — верхний потолок кадра. */
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
/** Ниже этого размера соцсеть рисует не крупную карточку, а мелкую иконку сбоку. */
const OG_MIN_WIDTH = 600;
const OG_MIN_HEIGHT = 315;

/** Статическая обложка на замену: у неё нет исходника для честного расчёта
 *  размера, поэтому её собственные 1200×630 заявляются как есть — файл лежит
 *  в `public/og/` и его размер контролирует тот, кто его туда положил. */
export const OG_FALLBACK: OgFrame = { src: SITE.ogImage, width: OG_WIDTH, height: OG_HEIGHT };

/**
 * Строит честный OG-кадр (JPEG, ≤1200×630, без апскейла) из значения
 * картиночного поля контента (ключ реестра `src/assets/**`, легаси-путь
 * `/images/cms/…` или обычный публичный URL). Не-растр (SVG, внешний URL) и
 * слишком мелкий исходник — оба уходят в `OG_FALLBACK`: SVG сервис картинок
 * не кадрирует, а мелкий кадр соцсеть всё равно нарисует иконкой.
 *
 * Генерик: страница каталога зовёт это для обложки товара/категории, страница
 * блога — для обложки статьи; обе просто передают своё поле `image`.
 */
export async function resolveOgImage(src?: string): Promise<OgFrame> {
  if (!src) return OG_FALLBACK;
  const classified = classifyImageSource(src, asset);
  if (classified.kind !== 'raster') return OG_FALLBACK;
  try {
    // ⚠️ В МЕТУ УХОДИТ ФАКТИЧЕСКИЙ РАЗМЕР ФАЙЛА, А НЕ ЗАПРОШЕННЫЙ — см. doc-comment
    // модуля.
    const width = Math.min(OG_WIDTH, classified.img.width);
    const height = Math.min(OG_HEIGHT, classified.img.height);
    if (width < OG_MIN_WIDTH || height < OG_MIN_HEIGHT) return OG_FALLBACK;

    const og = await getImage({
      src: classified.img,
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fit: 'cover',
      format: 'jpeg',
    });
    return { src: og.src, width, height };
  } catch (err) {
    console.warn(`[og-image] не удалось подготовить OG-кадр из ${src} — использую ${OG_FALLBACK.src}`, err);
    return OG_FALLBACK;
  }
}
