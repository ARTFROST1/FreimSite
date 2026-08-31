/**
 * Значение поля-картинки из контента → что рендерить.
 *
 * ЗАЧЕМ. `astro:assets` требует `ImageMetadata` из статического импорта, а в
 * JSON лежит строка (её пишет CMS-портал). Реестр (`registry.ts`) собирает все
 * файлы `src/assets/**` на сборке, а этот модуль решает, чем является строка:
 *
 *   'cms/a.png'              → ключ реестра        → оптимизируется <Image>
 *   '/images/cms/a.png'      → ЛЕГАСИ-значение     → пробуем как ключ 'cms/a.png',
 *                                                    иначе отдаём как публичный URL
 *   '/images/placeholder.svg'→ публичный путь      → отдаём как есть
 *
 * Чистый модуль без импортов Astro-рантайма — поэтому тестируется юнит-тестом.
 */
import type { ImageMetadata } from 'astro';

export type ResolvedImage =
  | { kind: 'asset'; img: ImageMetadata }
  | { kind: 'url'; url: string };

/** Куда падаем, если ключ реестра не нашёлся (см. Global Constraints: контент
 *  клиента никогда не роняет сборку). Файл лежит в `public/images/`. */
export const IMAGE_FALLBACK_URL = '/images/placeholder.svg';

/** Префикс, по которому портал публиковал картинки до этого переезда. */
const LEGACY_CMS_PREFIX = '/images/cms/';

/**
 * Ключ реестра (путь от `src/assets/`) или `null`, если значение — обычный
 * URL/публичный путь. `..` не пропускаем: ключ приходит из JSON, который
 * пишет портал, и не должен уметь адресовать что-либо вне `src/assets/`.
 */
export function assetKeyFor(value: string): string | null {
  if (!value) return null;
  const key = value.startsWith(LEGACY_CMS_PREFIX)
    ? `cms/${value.slice(LEGACY_CMS_PREFIX.length)}`
    : value;
  if (key.startsWith('/') || key.includes('://')) return null;
  if (key.split('/').some((segment) => segment === '..')) return null;
  return key;
}

export function resolveImageValue(
  value: string,
  lookup: (key: string) => ImageMetadata | undefined,
): ResolvedImage {
  const key = assetKeyFor(value);
  if (key === null) return { kind: 'url', url: value };

  const img = lookup(key);
  if (img) return { kind: 'asset', img };

  // Легаси-значение, файл которого ещё лежит в public/ — отдаём как URL.
  if (value.startsWith('/')) return { kind: 'url', url: value };

  // Ключ есть, файла нет: битая ссылка в контенте. Не роняем сборку.
  console.warn(`[images] нет файла src/assets/${key} — рендерю ${IMAGE_FALLBACK_URL}`);
  return { kind: 'url', url: IMAGE_FALLBACK_URL };
}

/** Что можно передать в компонент как картинку: метаданные из реестра
 *  (`asset('hero/1.webp')`) или строка из контента/публичный путь. */
export type ImageSource = ImageMetadata | string;

export type ImageKind = 'raster' | 'svg' | 'url';

/**
 * Единая классификация источника картинки: `ImageSource` → растр / SVG / URL.
 *
 * ЗАЧЕМ. `ContentImage` (выбор `<Image>` vs `<img>`) и `GalleryGrid`
 * (URL для лайтбокса) оба должны знать, что перед ними — но это одна и та же
 * трёхвариантная классификация («значение уже `ImageMetadata`, или строка,
 * которая через `resolveImageValue` резолвится в asset/url, а если asset —
 * то ещё отдельно SVG или растр»). Без общей функции оба места повторяли бы
 * эту цепочку условий, и логика неизбежно разошлась бы при следующей правке.
 */
export function classifyImageSource(
  src: ImageSource,
  lookup: (key: string) => ImageMetadata | undefined,
): { kind: 'raster' | 'svg'; img: ImageMetadata } | { kind: 'url'; url: string } {
  const resolved = typeof src === 'string' ? resolveImageValue(src, lookup) : { kind: 'asset' as const, img: src };
  if (resolved.kind === 'url') return { kind: 'url', url: resolved.url };
  return resolved.img.format === 'svg' ? { kind: 'svg', img: resolved.img } : { kind: 'raster', img: resolved.img };
}
