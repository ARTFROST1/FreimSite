#!/usr/bin/env node
/**
 * Шаг 1 медиа-конвейера (docs/recipes/photo-archive.md): единый индекс всех
 * кадров всех пулов.
 *
 * ЗАЧЕМ. Фото клиента приходят из нескольких источников (авторская съёмка по
 * папкам, выгрузка старого сайта, россыпь), и пока каждый разбирается своим
 * скриптом — кадры разных источников слипаются, а дубли расползаются по
 * товарам. Индекс сводит всё в одну таблицу: дальше дедуп, разметка и
 * раскладка работают с ней, а не с тремя несогласованными.
 *
 * Пулы объявлены в `media.config.mjs` (POOLS) — этот файл проектных путей не
 * содержит.
 *
 * ЧТО СЧИТАЕТ. На кадр: размеры, md5 исходника и перцептивный хеш (dHash-64).
 * pHash обязателен: клиентские архивы — это одни и те же снимки, пережатые
 * трижды (телефон → мессенджер → старый сайт); md5 у копий разный, картинка
 * одна. dHash переживает пережатие и ресайз.
 *
 * HEIC читается через `sips` (см. lib/readable-image.mjs) — sharp без libheif
 * его не открывает. DNG пропускаем: RAW-дубли тех же кадров.
 *
 * КЭШ. Хеши кэшируются по `path+size+mtime` — повторный прогон мгновенный.
 * `--force` пересчитывает всё.
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { withReadableImage } from './lib/readable-image.mjs';
import { REPO_ROOT, STAGING, POOLS } from './media.config.mjs';

const OUT_PATH = path.join(STAGING, 'media-index.json');
const CACHE_PATH = path.join(STAGING, 'media-index.cache.json');

const PHOTO_EXTS = new Set(['.heic', '.jpg', '.jpeg', '.png', '.webp']);
const isJunk = (name) => name.startsWith('._') || name === '.DS_Store';

/**
 * dHash-64: кадр в оттенках серого сжимается до 9×8, каждый бит — «пиксель
 * левее соседа темнее?». Возвращает 16 hex-символов.
 */
async function dHash(buf) {
  const px = await sharp(buf).rotate().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) bits += px[row * 9 + col] > px[row * 9 + col + 1] ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function walkPhotos(dir) {
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (isJunk(entry.name)) continue;
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (PHOTO_EXTS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
}

/** Кадры одного пула: файл + товар (если attribution его знает). */
function collectPool(pool) {
  const root = path.join(REPO_ROOT, pool.dir);
  const out = [];
  for (const file of walkPhotos(root)) {
    const rel = path.relative(root, file);
    let product = null;
    if (pool.attribution === 'folders') {
      const [cat, slug] = rel.split(path.sep);
      product = slug ? `${cat}/${slug}` : null;
    } else if (pool.attribution === 'map') {
      const folder = rel.split(path.sep)[0];
      product = pool.folderMap?.[folder] ?? null;
    }
    out.push({ source: pool.name, rank: pool.rank ?? 9, file, product });
  }
  return out;
}

async function main() {
  const force = process.argv.includes('--force');
  if (!POOLS.length) {
    console.error('POOLS пуст — заполните scripts/media.config.mjs (см. docs/recipes/photo-archive.md).');
    process.exit(1);
  }
  const cache = !force && existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};

  const candidates = POOLS.flatMap(collectPool);
  console.error(`Кадров-кандидатов: ${candidates.length}`);

  const items = [];
  const nextCache = {};
  let hashed = 0;
  const failed = [];

  for (const c of candidates) {
    const st = statSync(c.file);
    const cacheKey = `${c.file}|${st.size}|${Math.round(st.mtimeMs)}`;
    let meta = cache[cacheKey];
    if (!meta) {
      try {
        meta = await withReadableImage(c.file, async (buf) => {
          const dims = await sharp(buf).rotate().metadata();
          return {
            width: dims.width ?? 0,
            height: dims.height ?? 0,
            md5: crypto.createHash('md5').update(buf).digest('hex'),
            phash: await dHash(buf),
          };
        });
        hashed += 1;
      } catch (err) {
        failed.push(`${c.file}: ${err.message}`);
        continue;
      }
    }
    nextCache[cacheKey] = meta;

    items.push({
      // id стабилен между прогонами — путь от корня репозитория. На него
      // ссылаются assignments.json и media-overrides.json, поэтому НЕ менять.
      id: path.relative(REPO_ROOT, c.file),
      source: c.source,
      rank: c.rank,
      file: path.relative(REPO_ROOT, c.file),
      product: c.product,
      ...meta,
    });
    if (items.length % 200 === 0) console.error(`  …${items.length}/${candidates.length}`);
  }

  mkdirSync(STAGING, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify({ version: 1, items }, null, 2));
  writeFileSync(CACHE_PATH, JSON.stringify(nextCache));

  const byPool = {};
  const withProduct = {};
  for (const i of items) {
    byPool[i.source] = (byPool[i.source] ?? 0) + 1;
    if (i.product) withProduct[i.source] = (withProduct[i.source] ?? 0) + 1;
  }
  console.error(`\nПроиндексировано: ${items.length} (посчитано ${hashed}, из кэша ${items.length - hashed})`);
  for (const pool of Object.keys(byPool)) {
    console.error(`  ${pool.padEnd(10)} ${String(byPool[pool]).padStart(4)} кадров, с товаром: ${withProduct[pool] ?? 0}`);
  }
  if (failed.length) {
    console.error(`\nНе прочитано: ${failed.length}`);
    failed.slice(0, 10).forEach((f) => console.error(`  ${f}`));
  }
  console.error(`\n→ ${path.relative(REPO_ROOT, OUT_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
