#!/usr/bin/env node
/**
 * Второй заход разметки (docs/recipes/photo-archive.md, шаг 3): контактные
 * листы 3×3 для кадров общего индекса (`media-index.json`), которые ЕЩЁ НЕ
 * размечены и при этом реально влияют на раскладку. Разметку по этим листам
 * делает человек (или агент, читающий картинку) и пишет её через
 * `merge-classification.mjs --set=main`.
 *
 * ЧТО СЮДА НЕ ПОПАДАЕТ И ПОЧЕМУ
 * -----------------------------
 * 1. Кадры, уже размеченные напрямую или унаследовавшие разметку по группе
 *    дублей (`resolveFrames` в lib/media-groups.mjs): pHash-пересечение пулов
 *    на живом архиве давало десятки групп, и заметная часть кадров получала
 *    тип съёмки бесплатно, просто потому что дубль уже размечен в другом пуле.
 * 2. Кадры уже `SLIDER_MIN_FRAME_WIDTH` px (media.config.mjs) из любого пула —
 *    ниже этой ширины кадр физически не проходит в слайдер, размечать его
 *    незачем.
 * 3. Пулы целиком, максимум ширины которых ниже того же порога. Скрап старого
 *    сайта — типичный случай: у него всегда меньший максимум, чем у порога
 *    слайдера, и НИ ОДИН его кадр не пройдёт в слайдер независимо от того,
 *    что на нём изображено; размечать такой пул листами — это лишние листы
 *    ради решения, которое уже приняла ширина. Правило считает максимум по
 *    каждому пулу из индекса и отбрасывает пул целиком, если ни один его
 *    кадр не может выиграть.
 *
 * ФОРМАТ ЛИСТА — как у `build-collages.mjs` (3×3 ячейки по 420 px, номер в
 * углу), чтобы разметка шла привычно между заходами.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { resolveFrames } from './lib/media-groups.mjs';
import { withReadableImage } from './lib/readable-image.mjs';
import { REPO_ROOT, STAGING, SLIDER_MIN_FRAME_WIDTH, POOLS } from './media.config.mjs';
// archivePoolDir()/isPoolRegistered() — та же проверка и то же вычисление
// пути, что использует merge-classification.mjs (--set=archive) при записи
// classification.json. Импорт safe: main() того модуля не гоняется при
// импорте, см. guard в его конце.
import { archivePoolDir, isPoolRegistered } from './merge-classification.mjs';

const INDEX_PATH = path.join(STAGING, 'media-index.json');
const CLASSIFICATION_PATH = path.join(STAGING, 'classification.json');
const GALLERY_MANIFEST_PATH = path.join(STAGING, 'gallery/manifest.json');
const OUT_DIR = path.join(STAGING, 'media-collages');

const CELL = 420;
const GRID = 3;
const PER_SHEET = GRID * GRID;

async function cell(frame) {
  const abs = path.join(REPO_ROOT, frame.file);
  return withReadableImage(abs, (buf) =>
    sharp(buf).rotate().resize(CELL, CELL, { fit: 'cover', position: 'centre' }).toBuffer());
}

function numberBadge(n) {
  return Buffer.from(
    `<svg width="${CELL}" height="${CELL}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="8" y="8" width="60" height="60" rx="8" fill="rgba(0,0,0,0.72)"/>` +
      `<text x="38" y="55" font-size="46" font-weight="bold" fill="#fff" text-anchor="middle" font-family="sans-serif">${n}</text>` +
      `</svg>`,
  );
}

/** Максимум ширины кадра по каждому исходному пулу — как есть, до дедупа. */
function maxWidthBySource(items) {
  const out = new Map();
  for (const item of items) {
    if ((out.get(item.source) ?? 0) < item.width) out.set(item.source, item.width);
  }
  return out;
}

async function main() {
  if (!existsSync(INDEX_PATH)) {
    console.error(`Нет ${path.relative(REPO_ROOT, INDEX_PATH)} — сначала node scripts/build-media-index.mjs`);
    process.exit(1);
  }

  // Гвард вместо «доверяй документации»: если где-то в проекте прогонялся
  // архивный заход (prepare-gallery.mjs оставил manifest.json), но пул
  // '.staging/gallery/full' не зарегистрирован в POOLS (или зарегистрирован
  // не с тем dir), его разметка молча превратится в «сироту» — этот скрипт
  // заново предложит размечать то, что уже размечено набором `archive`,
  // просто под другим id. Если manifest.json нет, архивный заход не
  // использовался — проверять нечего.
  if (existsSync(GALLERY_MANIFEST_PATH)) {
    const dir = archivePoolDir();
    if (!isPoolRegistered(POOLS, dir)) {
      console.error(
        `Найден ${path.relative(STAGING, GALLERY_MANIFEST_PATH)} (архивный заход разметки уже был), ` +
          `но POOLS (scripts/media.config.mjs) не содержит пул с dir: '${dir}'. Разметка набора «archive» ` +
          `не найдётся в общем индексе под правильным id. Добавьте { name: 'archive', dir: '${dir}', ` +
          `attribution: 'none' } в POOLS, пересоберите индекс (node scripts/build-media-index.mjs) и повторите прогон.`,
      );
      process.exit(1);
    }
  }

  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8')).items;
  const classification = existsSync(CLASSIFICATION_PATH)
    ? JSON.parse(readFileSync(CLASSIFICATION_PATH, 'utf8')).items
    : {};

  const frames = resolveFrames(index, { classification });

  const lowResSources = new Set(
    [...maxWidthBySource(index)].filter(([, w]) => w < SLIDER_MIN_FRAME_WIDTH).map(([source]) => source),
  );
  if (lowResSources.size) {
    console.error(
      `Пулы ниже порога слайдера (${SLIDER_MIN_FRAME_WIDTH}px), размечать нечего: ${[...lowResSources].join(', ')}`,
    );
  }

  const todo = frames
    .filter((f) => f.shot === null)
    .filter((f) => f.width >= SLIDER_MIN_FRAME_WIDTH)
    .filter((f) => !lowResSources.has(f.source))
    .sort((a, b) => String(a.product).localeCompare(String(b.product), 'ru') || a.file.localeCompare(b.file, 'en', { numeric: true }));

  console.error(`Кадров всего (после схлопывания дублей): ${frames.length}`);
  console.error(`Уже размечено (своей меткой или по группе): ${frames.filter((f) => f.shot !== null).length}`);
  console.error(`К разметке: ${todo.length} → листов ${Math.ceil(todo.length / PER_SHEET)}`);

  if (!todo.length) return;

  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) unlinkSync(path.join(OUT_DIR, f));

  const sheets = [];
  for (let s = 0; s * PER_SHEET < todo.length; s++) {
    const slice = todo.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    const composites = [];
    for (let i = 0; i < slice.length; i++) {
      const x = (i % GRID) * CELL;
      const y = Math.floor(i / GRID) * CELL;
      composites.push({ input: await cell(slice[i]), left: x, top: y });
      composites.push({ input: numberBadge(i + 1), left: x, top: y });
    }
    const name = `${String(s + 1).padStart(3, '0')}.webp`;
    await sharp({
      create: {
        width: CELL * GRID, height: CELL * GRID, channels: 3,
        background: { r: 24, g: 25, b: 30 },
      },
    })
      .composite(composites)
      .webp({ quality: 78 })
      .toFile(path.join(OUT_DIR, name));

    sheets.push({
      collage: name,
      cells: slice.map((f, i) => ({
        n: i + 1, id: f.id, product: f.product, size: `${f.width}x${f.height}`,
      })),
    });
    console.error(`  ${name}  (${slice.length})`);
  }

  writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(sheets, null, 2));
  console.error(`\n→ ${path.relative(REPO_ROOT, OUT_DIR)}`);
  console.error('Дальше: разметить листы → node scripts/merge-classification.mjs --set=main');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
