/**
 * Реестр картинок из `src/assets/**` — единая точка доступа.
 *
 * ЗАЧЕМ. Всё, что лежит в `src/`, Astro прогоняет через `astro:assets`: ресайз,
 * webp/avif, `srcset`, `width/height` (нет скачка вёрстки), хеш в имени (вечный
 * кэш). Файлы в `public/` отдаются как есть, без этого. Статические импорты по
 * файлу не годятся: 40 фото галереи = 40 строк import, а CMS вообще присылает
 * путь строкой. `import.meta.glob(..., { eager: true })` сохраняет свойство
 * «положил файл в папку → он появился на сайте» и добавляет оптимизацию.
 *
 * ВАЖНО: паттерн glob обязан быть ЛИТЕРАЛОМ — Vite резолвит его статически.
 * `.svg` включён сознательно: портал разрешает загрузку SVG, а `ImageMetadata`
 * у него есть (Astro 7 отдаёт `SvgComponent & ImageMetadata`); не-растр
 * `ContentImage` рендерит обычным `<img>`, без sharp.
 */
import type { ImageMetadata } from 'astro';

const MODULES = import.meta.glob<{ default: ImageMetadata }>(
  '/src/assets/**/*.{webp,avif,jpg,jpeg,png,svg}',
  { eager: true },
);

export interface AssetEntry {
  /** Имя файла с расширением, напр. `cover.webp`. */
  name: string;
  /** Путь от `src/assets/`, напр. `gallery/cover.webp`. */
  key: string;
  img: ImageMetadata;
}

const REGISTRY = new Map<string, ImageMetadata>();
for (const [full, mod] of Object.entries(MODULES)) {
  REGISTRY.set(full.replace('/src/assets/', ''), mod.default);
}

/** Одна картинка по ключу; `undefined`, если файла нет. */
export function asset(key: string): ImageMetadata | undefined {
  return REGISTRY.get(key);
}

/** Человеко-числовая сортировка: `2.webp` раньше `10.webp`. */
const byName = (a: string, b: string) => a.localeCompare(b, 'ru', { numeric: true });

/** Прямые дети папки `dir` (без вложенных подпапок), отсортированы по имени. */
export function assetsIn(dir: string): AssetEntry[] {
  const prefix = dir.replace(/\/+$/, '') + '/';
  const out: AssetEntry[] = [];
  for (const [key, img] of REGISTRY) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest.includes('/')) continue;
    out.push({ name: rest, key, img });
  }
  return out.sort((a, b) => byName(a.name, b.name));
}

/** Обложка папки: файл `cover.*`, если есть; иначе первый по имени. */
export function coverIn(dir: string): ImageMetadata | null {
  const files = assetsIn(dir);
  if (files.length === 0) return null;
  return (files.find((f) => /^cover\.[a-z0-9]+$/i.test(f.name)) ?? files[0]).img;
}
