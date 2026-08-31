#!/usr/bin/env node
/**
 * Второй шаг работы с россыпью (docs/recipes/photo-archive.md): манифест
 * `prepare-gallery.mjs` → контактные листы 3×3 для ручной разметки типа кадра.
 *
 * ЗАЧЕМ КОЛЛАЖИ, А НЕ ПОШТУЧНЫЙ ПРОСМОТР. Человек (или VLM) должен пройти
 * сотни кадров быстро — лист с номерами в углу ячейки даёт узнаваемую сетку
 * координат, по которой разметка ложится в JSON без риска перепутать кадр.
 * Формат листа совпадает с `build-media-collages.mjs` (второй заход
 * разметки, уже по индексированным кадрам) — так разметчик не переучивается
 * между заходами.
 *
 * ВЫХОД: `.staging/collages/NNN.webp` (сами листы) + `index.json`
 * (`{ collage, cells: [{ n, id }] }[]`) — по нему `merge-classification.mjs
 * --set=archive` проверяет, что разметка покрывает ровно эти кадры и не
 * содержит лишних.
 *
 * Запуск:
 *   node scripts/build-collages.mjs        # собрать листы
 *   node scripts/build-collages.mjs --dry  # план (сколько листов), без записи
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { STAGING } from './media.config.mjs';

const stagingGalleryDir = path.join(STAGING, 'gallery');
const collagesDir = path.join(STAGING, 'collages');
const manifestPath = path.join(stagingGalleryDir, 'manifest.json');

const CELL_SIZE = 420;
const GRID_SIZE = 3;
const CELLS_PER_COLLAGE = GRID_SIZE * GRID_SIZE;
const OUTPUT_SIZE = CELL_SIZE * GRID_SIZE;
const WEBP_QUALITY = 80;
const DRY_RUN = process.argv.includes('--dry');

async function generateNumberOverlay(num) {
  const svg = `
    <svg width="${CELL_SIZE}" height="${CELL_SIZE}" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="8" width="60" height="60" rx="8" fill="rgba(0, 0, 0, 0.7)" />
      <text x="38" y="55" font-size="48" font-weight="bold" fill="white" text-anchor="middle" font-family="sans-serif">${num}</text>
    </svg>
  `;
  return Buffer.from(svg);
}

async function buildCollage(items) {
  const images = [];

  for (let i = 0; i < CELLS_PER_COLLAGE; i++) {
    const item = items[i];
    if (!item) break;

    const thumbPath = path.join(stagingGalleryDir, item.thumb);

    try {
      const image = sharp(thumbPath);
      const metadata = await image.metadata();

      // cover-масштабирование: приводим кадр к квадрату ячейки, обрезая
      // лишнее по центру, чтобы вся сетка листа была ровной.
      const scale = Math.max(CELL_SIZE / metadata.width, CELL_SIZE / metadata.height);
      const newWidth = Math.round(metadata.width * scale);
      const newHeight = Math.round(metadata.height * scale);

      const resized = await image
        .resize(newWidth, newHeight, { fit: 'cover' })
        .toBuffer();

      const numberOverlay = await generateNumberOverlay(i + 1);

      const cellWithNumber = await sharp(resized)
        .composite([{ input: numberOverlay, gravity: 'northwest' }])
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();

      images.push({
        input: cellWithNumber,
        left: (i % GRID_SIZE) * CELL_SIZE,
        top: Math.floor(i / GRID_SIZE) * CELL_SIZE,
      });
    } catch (err) {
      console.error(`Ошибка на кадре ${item.id}: ${err.message}`);
      // Серый плейсхолдер вместо пустой ячейки: лист остаётся полным по
      // сетке, а разметчик видит, что кадр не прочитался, а не что его нет.
      const placeholder = await sharp({
        create: {
          width: CELL_SIZE,
          height: CELL_SIZE,
          channels: 3,
          background: { r: 200, g: 200, b: 200 },
        },
      })
        .composite([{ input: await generateNumberOverlay(i + 1), gravity: 'northwest' }])
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();

      images.push({
        input: placeholder,
        left: (i % GRID_SIZE) * CELL_SIZE,
        top: Math.floor(i / GRID_SIZE) * CELL_SIZE,
      });
    }
  }

  return sharp({
    create: {
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(images)
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

async function main() {
  if (!fs.existsSync(manifestPath)) {
    console.error(`Нет ${path.relative(STAGING, manifestPath)} — сначала node scripts/prepare-gallery.mjs`);
    process.exit(1);
  }

  if (!DRY_RUN && !fs.existsSync(collagesDir)) {
    fs.mkdirSync(collagesDir, { recursive: true });
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const totalItems = manifest.length;
  const totalCollages = Math.ceil(totalItems / CELLS_PER_COLLAGE);

  console.log(`Кадров: ${totalItems}, листов: ${totalCollages}`);
  if (DRY_RUN) console.log('--dry: ничего не записано\n');

  const collageIndex = [];

  for (let collageNum = 0; collageNum < totalCollages; collageNum++) {
    const startIdx = collageNum * CELLS_PER_COLLAGE;
    const endIdx = Math.min(startIdx + CELLS_PER_COLLAGE, totalItems);
    const items = manifest.slice(startIdx, endIdx);
    const collageName = String(collageNum + 1).padStart(3, '0');
    const collageFile = path.join(collagesDir, `${collageName}.webp`);

    console.log(`[${collageNum + 1}/${totalCollages}] ${collageName}: ${items.length} кадров`);

    if (!DRY_RUN) {
      try {
        const collageBuffer = await buildCollage(items);
        fs.writeFileSync(collageFile, collageBuffer);
      } catch (err) {
        console.error(`  ОШИБКА: ${err.message}`);
        continue;
      }
    }

    collageIndex.push({
      collage: `${collageName}.webp`,
      cells: items.map((item, i) => ({ n: startIdx + i + 1, id: item.id })),
    });
  }

  if (!DRY_RUN) {
    const indexPath = path.join(collagesDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(collageIndex, null, 2));
    console.log(`\n→ ${indexPath}`);
  }

  console.log(`\nГотово: ${totalCollages} листов из ${totalItems} кадров.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
