#!/usr/bin/env node
/**
 * Данные для `/sortirovka/` — все кадры каталога, а не только россыпь.
 * Заменяет `prepare-sorter-public.mjs` (тот знал только `.staging/gallery/`).
 *
 * ЗАЧЕМ ПЕРЕДЕЛАНО. Первая версия сортировщика показывала 508 кадров архива и
 * просила сгруппировать их с нуля. Но из 1062 кадров каталога 702 УЖЕ знают
 * свой товар: 175 — из папок, которые заказчик сам назвал по моделям
 * («главная/диван нова»), 509 — из структуры старого сайта, 18 — совпали по
 * перцептивному хешу с кадрами «главной». Просить человека заново
 * группировать то, что разложено верно, — это лишние часы и риск сломать
 * правильное. Поэтому сортировщик теперь открывается на ГОТОВОЙ раскладке, а
 * работа сводится к «поправь, где неверно» плюс разбери 360 безымянных.
 *
 * ЧТО КЛАДЁТСЯ В public/sorter/
 * -----------------------------
 *   frames.json    все кадры: id, размеры, товар, тип съёмки, слой, источник
 *   catalog.json   товары каталога (id, название, категория, обложка)
 *   thumb/*.webp   плитки сетки, 400 px
 *   view/*.webp    крупный просмотр, VIEW_WIDTH px
 *
 * `product` и `layer` во frames.json — ТЕКУЩЕЕ состояние сайта, а не пустые
 * поля: сортировщик показывает то, что реально на сайте, и правки идут от
 * этого. Источник — тот же `resolveFrames` + правило слоёв, что у
 * `apply-media.mjs`, плюс уже сделанные правки из `.staging/assignments.json`.
 *
 * ИДЕМПОТЕНТНОСТЬ. Превью пересобирается, только если его ещё нет: имя файла
 * содержит md5 исходника, так что изменившийся кадр получает новое имя, а
 * неизменившийся переиспользуется. Лишние файлы подчищаются.
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync,
} from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import YAML from 'yaml';
import { resolveFrames } from './lib/media-groups.mjs';
import { withReadableImage } from './lib/readable-image.mjs';
import { layerFor, readAssignments, readOverrides, mergeOverrides, resolveProductAlias } from './lib/media-layers.mjs';
import { REPO_ROOT, STAGING } from './media.config.mjs';

const WEBSITE_ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(WEBSITE_ROOT, 'public/sorter');
const PRODUCTS_DIR = path.join(WEBSITE_ROOT, 'src/content/products');
const CATEGORIES = path.join(WEBSITE_ROOT, 'src/content/catalog/categories.json');

const THUMB_WIDTH = 400;
const THUMB_QUALITY = 70;
/** 800, а не 1000: 1062 кадра вместо 508 — сборка выросла бы до ~90 МБ, а у
 *  деплоя уже был таймаут по размеру. Модель и обивку на 800 px видно. */
const VIEW_WIDTH = 800;
const VIEW_QUALITY = 72;

async function build(srcAbs, destAbs, width, quality) {
  if (existsSync(destAbs)) return 'same';
  await withReadableImage(srcAbs, async (buf) => {
    await sharp(buf)
      .rotate()
      .resize(width, width, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toFile(destAbs);
  });
  return 'built';
}

function readCatalog() {
  const categories = JSON.parse(readFileSync(CATEGORIES, 'utf8'));
  const products = [];
  for (const file of readdirSync(PRODUCTS_DIR).filter((f) => f.endsWith('.md'))) {
    const slug = file.replace(/\.md$/, '');
    const d = YAML.parse(readFileSync(path.join(PRODUCTS_DIR, file), 'utf8').match(/^---\n([\s\S]*?)\n---/)[1]);
    products.push({
      key: `${d.category}/${slug}`,
      slug,
      title: d.title,
      category: d.category,
      draft: Boolean(d.draft),
    });
  }
  products.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  return { categories: categories.map((c) => ({ id: c.id, name: c.name })), products };
}

async function main() {
  const index = JSON.parse(readFileSync(path.join(STAGING, 'media-index.json'), 'utf8')).items;
  const classificationPath = path.join(STAGING, 'classification.json');
  const classification = existsSync(classificationPath)
    ? JSON.parse(readFileSync(classificationPath, 'utf8')).items
    : {};
  const assignments = readAssignments(STAGING);

  const frames = resolveFrames(index, { classification, assignments: assignments.product });

  // Та же отбраковка, что в apply-media: помеченный кадр понижается в галерею,
  // но остаётся видимым — сортировщик и сайт показывают одно и то же.
  mergeOverrides(frames, readOverrides(STAGING), assignments);

  mkdirSync(path.join(OUT_DIR, 'thumb'), { recursive: true });
  mkdirSync(path.join(OUT_DIR, 'view'), { recursive: true });

  const keepThumb = new Set();
  const keepView = new Set();
  const out = [];
  const stats = { built: 0, same: 0, failed: 0 };

  for (const frame of frames) {
    const name = `${frame.md5}.webp`;
    const srcAbs = path.join(REPO_ROOT, frame.file);
    try {
      stats[await build(srcAbs, path.join(OUT_DIR, 'thumb', name), THUMB_WIDTH, THUMB_QUALITY)] += 1;
      await build(srcAbs, path.join(OUT_DIR, 'view', name), VIEW_WIDTH, VIEW_QUALITY);
    } catch (err) {
      stats.failed += 1;
      console.error(`  не собрано превью: ${frame.file} — ${err.message}`);
      continue;
    }
    keepThumb.add(name);
    keepView.add(name);

    out.push({
      id: frame.id,
      w: frame.width,
      h: frame.height,
      img: name,
      src: frame.source,
      shot: frame.shot,
      // Категория из авторазметки — ею фильтруется экран «Разбор» у кадров,
      // которым товар ещё не назначен. У привязанных категория берётся из
      // товара, поэтому здесь она нужна ровно для неразобранной россыпи.
      cat: frame.category ?? '',
      product: resolveProductAlias(frame.product),
      layer: layerFor(frame, assignments),
      note: frame.note || '',
    });

    if ((stats.built + stats.same) % 200 === 0) {
      console.error(`  …${stats.built + stats.same}/${frames.length}`);
    }
  }

  for (const [dir, keep] of [['thumb', keepThumb], ['view', keepView]]) {
    for (const f of readdirSync(path.join(OUT_DIR, dir))) {
      if (!keep.has(f)) unlinkSync(path.join(OUT_DIR, dir, f));
    }
  }

  writeFileSync(path.join(OUT_DIR, 'frames.json'), JSON.stringify({ version: 2, items: out }));
  writeFileSync(path.join(OUT_DIR, 'catalog.json'), JSON.stringify({ version: 2, ...readCatalog() }));

  const attributed = out.filter((f) => f.product).length;
  const byLayer = {};
  for (const f of out) byLayer[f.layer] = (byLayer[f.layer] ?? 0) + 1;

  console.error('');
  console.error(`Кадров: ${out.length} (превью собрано ${stats.built}, уже было ${stats.same}, ошибок ${stats.failed})`);
  console.error(`  привязаны к товару: ${attributed}, без привязки: ${out.length - attributed}`);
  console.error(`  слои: ${Object.entries(byLayer).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.error(`→ public/sorter/ (${VIEW_WIDTH} px просмотр)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
