#!/usr/bin/env node
/**
 * Спека `docs/history/specs/2026-08-11-media-layers-design.md`, §Конвейер п.6.
 *
 * Забирает сгенерированные обложки из `.staging/covers-out/<slug>.webp` и
 * кладёт их в `src/assets/products/<cat>/<slug>/cover.webp`.
 *
 * Дальше `apply-media.mjs` увидит файл `cover.webp` рядом с кадрами и сделает
 * его полем `image`, а лучший студийный кадр вернёт обратно в слайдер (до
 * генерации он был обложкой и из слайдера изымался). Порядок запуска:
 *   node scripts/import-covers.mjs && node scripts/apply-media.mjs
 *
 * ПРОВЕРКИ. Файл принимается, только если он действительно обложка:
 *   - соотношение сторон 4:3 с допуском ±2 % (в сетке каталога и в OG-кадре
 *     пропорция фиксирована, кадр другой пропорции будет обрезан — то есть
 *     ровно та проблема, ради которой канон и вводился);
 *   - ширина не меньше 1400 px, иначе на ретине обложка будет мылом;
 *   - slug соответствует существующему НЕчерновому товару.
 * Непрошедшие перечисляются в отчёте и не копируются — молча подменять
 * обложку кадром неверной пропорции нельзя.
 *
 * ФЛАГИ
 *   --dry   напечатать план, ничего не писать
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import YAML from 'yaml';
import { REPO_ROOT, STAGING, COVER_W, COVER_H } from './media.config.mjs';

const WEBSITE_ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(STAGING, 'covers-out');
const PRODUCTS_DIR = path.join(WEBSITE_ROOT, 'src/content/products');
const ASSETS_ROOT = path.join(WEBSITE_ROOT, 'src/assets');

const TARGET_RATIO = COVER_W / COVER_H;
const RATIO_TOLERANCE = 0.02;
const MIN_WIDTH = 1400;

async function main() {
  const dry = process.argv.includes('--dry');

  if (!existsSync(OUT_DIR)) {
    console.log(`Нет ${path.relative(REPO_ROOT, OUT_DIR)} — класть сюда готовые обложки <slug>.webp`);
    console.log('Очередь на генерацию готовит: node scripts/queue-covers.mjs');
    return;
  }

  const files = readdirSync(OUT_DIR).filter((f) => /\.(webp|jpe?g|png)$/i.test(f));
  const accepted = [];
  const rejected = [];

  for (const file of files) {
    const slug = file.replace(/\.[^.]+$/, '');
    const entryPath = path.join(PRODUCTS_DIR, `${slug}.md`);
    if (!existsSync(entryPath)) {
      rejected.push(`${file}: нет товара ${slug} в каталоге`);
      continue;
    }
    const data = YAML.parse(readFileSync(entryPath, 'utf8').match(/^---\n([\s\S]*?)\n---/)[1]);
    if (data.draft) {
      rejected.push(`${file}: товар ${slug} — черновик, на сайт не попадает`);
      continue;
    }

    const srcAbs = path.join(OUT_DIR, file);
    const meta = await sharp(srcAbs).metadata();
    const ratio = meta.width / meta.height;
    if (Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO > RATIO_TOLERANCE) {
      rejected.push(`${file}: пропорция ${ratio.toFixed(3)} вместо 4:3 (${TARGET_RATIO.toFixed(3)})`);
      continue;
    }
    if (meta.width < MIN_WIDTH) {
      rejected.push(`${file}: ширина ${meta.width} px, нужно от ${MIN_WIDTH}`);
      continue;
    }

    const destDir = path.join(ASSETS_ROOT, 'products', data.category, slug);
    const destAbs = path.join(destDir, 'cover.webp');
    if (!dry) {
      mkdirSync(destDir, { recursive: true });
      if (path.extname(file).toLowerCase() === '.webp') {
        copyFileSync(srcAbs, destAbs);
      } else {
        await sharp(srcAbs).webp({ quality: 88 }).toFile(destAbs);
      }
    }
    accepted.push(`${slug} (${meta.width}×${meta.height})`);
  }

  console.log(`Принято обложек: ${accepted.length}`);
  for (const a of accepted) console.log(`  ${a}`);
  if (rejected.length) {
    console.log(`\nОтклонено: ${rejected.length}`);
    for (const r of rejected) console.log(`  ${r}`);
  }
  if (dry) console.log('\n[DRY] Ничего не записано.');
  else if (accepted.length) console.log('\nДальше: node scripts/apply-media.mjs');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
