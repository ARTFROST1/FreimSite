#!/usr/bin/env node
/**
 * Спека `docs/history/specs/2026-08-11-media-layers-design.md`, §Контроль качества.
 *
 * Контактные листы для проверки раскладки ГЛАЗАМИ. Автоматика решает по порогу
 * («studio и шире 1200 px — в слайдер»), но порог не отличает предметную съёмку
 * от маркетплейсного баннера с наклеенным текстом, а таких среди кадров старого
 * сайта хватает. Лист — это способ увидеть 124 решения подряд, а не кликать по
 * 124 страницам.
 *
 * ДВА РЕЖИМА
 * ----------
 *   --covers   (по умолчанию) все обложки каталога подряд, подписаны slug'ом.
 *              Ищем: баннеры с текстом, каркасы без обивки, срезанные ножки.
 *   --product=<slug>  один товар: верхний ряд — что уехало в слайдер,
 *              нижние — что в галерею. Ищем: перепутанные слои.
 *
 * Что делать с находкой: вписать id кадра в `.staging/media-overrides.json`
 *   { "<id>": { "usable": false, "why": "баннер с текстом" } }
 * и перезапустить `apply-media.mjs` — обложкой станет следующий кандидат.
 * Id кадра печатается в подписи ячейки.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import YAML from 'yaml';
import { REPO_ROOT, STAGING } from './media.config.mjs';

const WEBSITE_ROOT = path.resolve(import.meta.dirname, '..');
// REPO_ROOT/STAGING — из media.config.mjs
const PRODUCTS_DIR = path.join(WEBSITE_ROOT, 'src/content/products');
const ASSETS_ROOT = path.join(WEBSITE_ROOT, 'src/assets');
const OUT_DIR = path.join(STAGING, 'review-sheets');

const CELL = 400;
const LABEL_H = 34;
const GRID = 3;
const PER_SHEET = GRID * GRID;

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

/** Ячейка = кадр + подпись под ним: без подписи лист бесполезен, находку не
 *  на что сослаться в media-overrides.json. */
async function cell(assetKey, caption, badge) {
  const img = await sharp(path.join(ASSETS_ROOT, assetKey))
    .resize(CELL, CELL - LABEL_H, { fit: 'cover', position: 'centre' })
    .toBuffer();
  const label = Buffer.from(
    `<svg width="${CELL}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${CELL}" height="${LABEL_H}" fill="#14151a"/>` +
      `<text x="8" y="23" font-size="16" fill="#edeff4" font-family="sans-serif">${escapeXml(caption)}</text>` +
      `</svg>`,
  );
  const composites = [
    { input: img, left: 0, top: 0 },
    { input: label, left: 0, top: CELL - LABEL_H },
  ];
  if (badge) {
    composites.push({
      input: Buffer.from(
        `<svg width="${CELL}" height="28" xmlns="http://www.w3.org/2000/svg">` +
          `<rect x="6" y="4" width="${18 + badge.length * 9}" height="22" rx="5" fill="rgba(0,0,0,.78)"/>` +
          `<text x="15" y="20" font-size="15" font-weight="bold" fill="#e2a45f" font-family="sans-serif">${escapeXml(badge)}</text>` +
          `</svg>`,
      ),
      left: 0,
      top: 0,
    });
  }
  // `.png()` обязателен: без явного формата composite отдаёт сырые пиксели без
  // заголовка, и внешний sharp такой буфер не примет.
  return sharp({ create: { width: CELL, height: CELL, channels: 3, background: { r: 20, g: 21, b: 26 } } })
    .composite(composites)
    .png()
    .toBuffer();
}

async function writeSheets(items, prefix) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) {
    if (f.startsWith(prefix)) unlinkSync(path.join(OUT_DIR, f));
  }
  const sheets = [];
  for (let s = 0; s * PER_SHEET < items.length; s++) {
    const slice = items.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    const composites = [];
    for (let i = 0; i < slice.length; i++) {
      composites.push({
        input: await cell(slice[i].key, slice[i].caption, slice[i].badge),
        left: (i % GRID) * CELL,
        top: Math.floor(i / GRID) * CELL,
      });
    }
    const rows = Math.ceil(slice.length / GRID);
    const name = `${prefix}-${String(s + 1).padStart(2, '0')}.webp`;
    await sharp({
      create: { width: CELL * GRID, height: CELL * rows, channels: 3, background: { r: 20, g: 21, b: 26 } },
    })
      .composite(composites)
      .webp({ quality: 80 })
      .toFile(path.join(OUT_DIR, name));
    sheets.push(name);
  }
  console.error(`${sheets.length} листов → ${path.relative(REPO_ROOT, OUT_DIR)}/${prefix}-*.webp`);
}

function readProduct(slug) {
  const raw = readFileSync(path.join(PRODUCTS_DIR, `${slug}.md`), 'utf8');
  return YAML.parse(raw.match(/^---\n([\s\S]*?)\n---/)[1]);
}

async function main() {
  const argv = process.argv.slice(2);
  const one = (argv.find((a) => a.startsWith('--product=')) ?? '').slice(10) || null;

  if (one) {
    const d = readProduct(one);
    const items = [
      { key: d.image, caption: `${one} — ОБЛОЖКА`, badge: 'обложка' },
      ...d.slider.map((k, i) => ({ key: k, caption: path.basename(k), badge: `слайдер ${i + 1}` })),
      ...d.gallery.map((k, i) => ({ key: k, caption: path.basename(k), badge: `галерея ${i + 1}` })),
    ].filter((it) => !it.key.startsWith('/'));
    await writeSheets(items, `product-${one}`);
    return;
  }

  const slugs = readdirSync(PRODUCTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();

  const items = [];
  for (const slug of slugs) {
    const d = readProduct(slug);
    if (d.draft) continue;
    if (String(d.image).startsWith('/')) continue;
    items.push({
      key: d.image,
      caption: `${slug}  ·  сл.${d.slider.length + 1} / гал.${d.gallery.length}`,
    });
  }
  console.error(`Обложек к проверке: ${items.length}`);
  await writeSheets(items, 'covers');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
