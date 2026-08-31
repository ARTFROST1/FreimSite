/**
 * ============================================================================
 *  optimize-images.mjs — one-shot image compressor
 *  (pattern from the catalogue reference).
 * ----------------------------------------------------------------------------
 * ОБЛАСТЬ ПОСЛЕ ПЕРЕЕЗДА В src/assets (2026-07):
 *   public/og/**      — да: OG-картинки Astro не обрабатывает, им нужен
 *                       стабильный URL и точные 1200×630.
 *   src/assets/**     — да, КРОМЕ src/assets/cms/**: astro:assets и так
 *                       ресайзит на сборке, но пережать оригинал полезно для
 *                       веса репозитория и времени сборки.
 *   src/assets/cms/** — НЕТ. На эти файлы ссылается контент по ключу реестра
 *                       (`cms/<uuid>.png`); смена расширения при конвертации в
 *                       webp порвала бы ссылку в JSON, которую пишет портал.
 *   public/images/**  — только то, что осталось (placeholder и подобное).
 *
 *  SVG is skipped. The original is deleted ONLY when the new file exists,
 *  is non-empty AND smaller. Writes scripts/.image-map.json (old→new paths)
 *  so you can rewrite references after a format change.
 *
 *  Usage:
 *    node scripts/optimize-images.mjs --dry     # report only
 *    node scripts/optimize-images.mjs           # convert
 *
 *  Requires sharp (devDependency).
 * ============================================================================
 */
import { readdirSync, statSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const DRY = process.argv.includes('--dry');
const IMAGES_DIR = 'public/images';
const OG_DIR = 'public/og';
const ASSETS_DIR = 'src/assets';
const MAX_EDGE = 2000;
const WEBP_QUALITY = 82;
const map = {};

// Каталоги, которые нельзя трогать при обходе (см. область выше).
const SKIP_DIRS = new Set(['cms']);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const fmt = (bytes) => `${(bytes / 1024).toFixed(0)}KB`;

async function toWebp(file) {
  const ext = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return;

  const src = sharp(file);
  const meta = await src.metadata();
  const before = statSync(file).size;

  // Skip already-small, already-webp files.
  if (ext === '.webp' && before < 200 * 1024 && (meta.width ?? 0) <= MAX_EDGE) return;

  const out = file.replace(/\.(png|jpe?g|webp)$/i, '.webp');
  const tmp = out + '.tmp';

  if (DRY) {
    console.log(`[dry] ${file} (${fmt(before)}) → ${out}`);
    return;
  }

  await src
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toFile(tmp);

  const after = statSync(tmp).size;
  if (after > 0 && (after < before || out !== file)) {
    if (existsSync(out) && out !== file) unlinkSync(out);
    const { renameSync } = await import('node:fs');
    renameSync(tmp, out);
    if (out !== file) {
      unlinkSync(file);
      map[file.replace('public', '')] = out.replace('public', '');
    }
    console.log(`✓ ${file} ${fmt(before)} → ${fmt(after)}`);
  } else {
    unlinkSync(tmp);
    console.log(`· ${file} kept (no gain)`);
  }
}

async function toOgJpeg(file) {
  const ext = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return;
  const out = file.replace(/\.(png|jpe?g|webp)$/i, '.jpg');
  const before = statSync(file).size;

  if (DRY) {
    console.log(`[dry] ${file} (${fmt(before)}) → ${out} 1200×630`);
    return;
  }
  const tmp = out + '.tmp';
  await sharp(file)
    .resize(1200, 630, { fit: 'cover' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(tmp);
  const { renameSync } = await import('node:fs');
  if (existsSync(out) && out !== file) unlinkSync(out);
  renameSync(tmp, out);
  if (out !== file) {
    unlinkSync(file);
    map[file.replace('public', '')] = out.replace('public', '');
  }
  console.log(`✓ og: ${file} → ${out} (${fmt(statSync(out).size)})`);
}

for (const file of walk(IMAGES_DIR)) {
  if (file.endsWith('.svg')) continue;
  await toWebp(file).catch((e) => console.error(`✗ ${file}: ${e.message}`));
}
for (const file of walk(ASSETS_DIR)) {
  if (file.endsWith('.svg')) continue;
  await toWebp(file).catch((e) => console.error(`✗ ${file}: ${e.message}`));
}
for (const file of walk(OG_DIR)) {
  if (file.endsWith('.svg')) continue;
  await toOgJpeg(file).catch((e) => console.error(`✗ ${file}: ${e.message}`));
}

if (!DRY && Object.keys(map).length) {
  writeFileSync('scripts/.image-map.json', JSON.stringify(map, null, 2));
  console.log(`\nPath changes written to scripts/.image-map.json — update references!`);
}
console.log(DRY ? '\nDry run complete.' : '\nDone.');
