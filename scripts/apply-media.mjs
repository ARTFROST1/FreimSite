#!/usr/bin/env node
/**
 * Шаг 4 медиа-конвейера (docs/recipes/photo-archive.md).
 *
 * ЕДИНСТВЕННЫЙ ВЛАДЕЛЕЦ полей `image` / `slider` / `gallery` у товаров.
 *
 * УРОК БОЕВОГО ПРОЕКТА, ради которого это существует: там медиа-поля писали три
 * скрипта разом, все в одну нумерацию `NN.webp`. Кто отработал последним,
 * того и кадр — обложками становился пережатый мусор, авторская съёмка
 * уезжала в глубину. Решение принимает ОДНО место и по явному правилу.
 *
 * ВХОД (всё в STAGING из media.config.mjs)
 *   media-index.json      все кадры всех пулов + pHash (build-media-index)
 *   classification.json   тип кадра: studio/interior/workshop/… (опционально)
 *   assignments.json      решения человека из /sortirovka/ (опционально)
 *   media-overrides.json  точечная отбраковка (опционально)
 *
 * ПРАВИЛА (общие с сортировщиком — lib/media-layers.mjs)
 *   - слой по типу кадра: герой не изделие (интерьер/событие/рендер/скриншот)
 *     → галерея; остальное → слайдер;
 *   - решение человека старше любой автоматики, явный `null` = открепить;
 *   - НИЧЕГО не выкидывается молча: брак понижается в галерею, но виден.
 *
 * ФАЙЛЫ: cover.webp (только сгенерированная обложка) / st-NN.webp (слайдер) /
 * int-NN.webp (галерея). Слой виден в имени.
 *
 * ИДЕМПОТЕНТНОСТЬ: кадр опознаётся по md5 исходника в `.media-manifest.json`
 * рядом с картинками; повторный прогон без изменений — нулевой diff.
 *
 * ФЛАГИ: --dry (план без записи), --only=<slug> (один товар).
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync,
} from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import YAML from 'yaml';
import { resolveFrames } from './lib/media-groups.mjs';
import {
  layerFor, readAssignments, readOverrides, mergeOverrides, resolveProductAlias,
  SLIDER_RANK, SLIDER_RANK_UNCLASSIFIED,
} from './lib/media-layers.mjs';
import { withReadableImage } from './lib/readable-image.mjs';
import {
  REPO_ROOT, STAGING, SLIDER_MAX, GALLERY_MAX, OUTPUT_MAX, OUTPUT_QUALITY,
} from './media.config.mjs';

const WEBSITE_ROOT = path.resolve(import.meta.dirname, '..');
const PRODUCTS_DIR = path.join(WEBSITE_ROOT, 'src/content/products');
const ASSETS_ROOT = path.join(WEBSITE_ROOT, 'src/assets');

const INDEX_PATH = path.join(STAGING, 'media-index.json');
const CLASSIFICATION_PATH = path.join(STAGING, 'classification.json');

const PLACEHOLDER_IMAGE = '/images/placeholder.svg';
const COVER_NAME = 'cover.webp';

/** Порядок ключей frontmatter — как в productSchema стартера. */
const FIELD_ORDER = [
  'title', 'category', 'shortDescription',
  'image', 'slider', 'gallery',
  'price', 'features', 'brands',
  'isHit', 'isNew', 'priority', 'draft', 'metaTitle', 'metaDescription',
];

const isJunk = (name) => name.startsWith('._') || name === '.DS_Store';
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
//  Чтение и запись контента
// ---------------------------------------------------------------------------

function readEntry(file) {
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${path.basename(file)}: не разобран frontmatter`);
  return { data: YAML.parse(m[1]) ?? {}, body: m[2] };
}

function writeEntry(file, data, body, dry) {
  const ordered = {};
  for (const key of FIELD_ORDER) if (key in data) ordered[key] = data[key];
  for (const key of Object.keys(data)) if (!(key in ordered)) ordered[key] = data[key];
  const yaml = YAML.stringify(ordered, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  const next = `---\n${yaml}---\n${body}`;
  if (existsSync(file) && readFileSync(file, 'utf8') === next) return 'same';
  if (!dry) writeFileSync(file, next, 'utf8');
  return 'written';
}

async function convert(relFile, destAbs) {
  await withReadableImage(path.join(REPO_ROOT, relFile), async (buf) => {
    await sharp(buf)
      .rotate()
      .resize(OUTPUT_MAX, OUTPUT_MAX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: OUTPUT_QUALITY })
      .toFile(destAbs);
  });
}

// ---------------------------------------------------------------------------
//  Порядок внутри слоёв
// ---------------------------------------------------------------------------

/** Слайдер: чистая предметка → без метки → цех; внутри группы крупное вперёд. */
const bySliderQuality = (a, b) =>
  (SLIDER_RANK[a.shot] ?? SLIDER_RANK_UNCLASSIFIED) - (SLIDER_RANK[b.shot] ?? SLIDER_RANK_UNCLASSIFIED) ||
  b.width * b.height - a.width * a.height;

/** Галерея: лучший пул вперёд, внутри пула стабильно по имени файла. */
const byGalleryOrder = (a, b) =>
  (a.rank ?? 9) - (b.rank ?? 9) ||
  a.file.localeCompare(b.file, 'en', { numeric: true, sensitivity: 'base' });

/**
 * Пригодность в обложку, когда явной нет. Размер решать не может: самым
 * крупным кадром часто оказывается каркас без обивки на складе, а рядом
 * лежит мелкое каталожное фото, где изделие показано целиком. Брак
 * (usable:false / watermark) — только когда больше нечего показать.
 */
const COVER_RANK = { studio: 0, interior: 1, render: 3, event: 4, workshop: 5, screenshot: 9 };
const COVER_RANK_UNCLASSIFIED = 2;
const coverPenalty = (f) => (f.usable === false || f.watermark === true ? 100 : 0);
const byCoverPreference = (a, b) =>
  coverPenalty(a) - coverPenalty(b) ||
  (COVER_RANK[a.shot] ?? COVER_RANK_UNCLASSIFIED) - (COVER_RANK[b.shot] ?? COVER_RANK_UNCLASSIFIED) ||
  b.width * b.height - a.width * a.height;

// ---------------------------------------------------------------------------
//  Раскладка одного товара
// ---------------------------------------------------------------------------

async function applyProduct(productKey, frames, ctx) {
  const [category, slug] = productKey.split('/');
  const file = path.join(PRODUCTS_DIR, `${slug}.md`);
  if (!existsSync(file)) {
    ctx.report.noEntry.push(productKey);
    return;
  }

  const destDir = path.join(ASSETS_ROOT, 'products', category, slug);
  const generatedCover = existsSync(path.join(destDir, COVER_NAME));

  // Слой каждого кадра: ручное решение из сортировщика, иначе автоматика.
  const layered = frames.map((f) => ({ frame: f, layer: layerFor(f, ctx.assignments) }));
  const sliderPool = layered.filter((l) => l.layer === 'slider').map((l) => l.frame).sort(bySliderQuality);
  const galleryPool = layered.filter((l) => l.layer === 'gallery').map((l) => l.frame).sort(byGalleryOrder);
  const pickedCover = layered.find((l) => l.layer === 'cover')?.frame ?? null;

  // Обложка: сгенерированная cover.webp > выбор человека > лучший слайд >
  // лучший кадр галереи. В случаях 2–4 кадр изымается из своего слоя, иначе
  // он же был бы первым слайдом и продублировался.
  let coverFrame = null;
  let sliderFrames = sliderPool;
  if (!generatedCover) {
    coverFrame = pickedCover ?? sliderPool[0] ?? [...galleryPool].sort(byCoverPreference)[0] ?? null;
    if (coverFrame && sliderPool.includes(coverFrame)) sliderFrames = sliderPool.slice(1);
  }

  // Хвост слайдера сверх лимита схемы не выбрасывается — переезжает в галерею.
  const sliderOverflow = sliderFrames.slice(SLIDER_MAX);
  sliderFrames = sliderFrames.slice(0, SLIDER_MAX);
  const galleryFrames = [...galleryPool, ...sliderOverflow]
    .filter((f) => f !== coverFrame)
    .sort(byGalleryOrder)
    .slice(0, GALLERY_MAX);

  // --- план файлов -------------------------------------------------------
  const plan = [];
  if (coverFrame) plan.push({ frame: coverFrame, name: 'st-01.webp', layer: 'cover' });
  sliderFrames.forEach((frame, i) => {
    plan.push({ frame, name: `st-${pad2(i + (coverFrame ? 2 : 1))}.webp`, layer: 'slider' });
  });
  galleryFrames.forEach((frame, i) => {
    plan.push({ frame, name: `int-${pad2(i + 1)}.webp`, layer: 'gallery' });
  });

  // --- запись файлов (идемпотентно по md5 исходника) ---------------------
  const manifestPath = path.join(destDir, '.media-manifest.json');
  const prevManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const nextManifest = {};
  const keep = new Set(generatedCover ? [COVER_NAME, '.media-manifest.json'] : ['.media-manifest.json']);

  if (!ctx.dry) mkdirSync(destDir, { recursive: true });
  for (const step of plan) {
    keep.add(step.name);
    nextManifest[step.name] = step.frame.md5;
    const destAbs = path.join(destDir, step.name);
    if (prevManifest[step.name] === step.frame.md5 && existsSync(destAbs)) {
      ctx.report.reused += 1;
      continue;
    }
    if (!ctx.dry) await convert(step.frame.file, destAbs);
    ctx.report.converted += 1;
  }
  if (existsSync(destDir)) {
    for (const name of readdirSync(destDir)) {
      if (isJunk(name) || keep.has(name)) continue;
      ctx.report.removed += 1;
      if (!ctx.dry) unlinkSync(path.join(destDir, name));
    }
  }
  if (!ctx.dry) writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 1));

  // --- запись frontmatter ------------------------------------------------
  const key = (name) => `products/${category}/${slug}/${name}`;
  const { data, body } = readEntry(file);
  const next = { ...data };
  next.image = generatedCover ? key(COVER_NAME) : coverFrame ? key('st-01.webp') : PLACEHOLDER_IMAGE;
  next.slider = plan.filter((s) => s.layer === 'slider').map((s) => key(s.name));
  next.gallery = plan.filter((s) => s.layer === 'gallery').map((s) => key(s.name));

  const result = writeEntry(file, next, body, ctx.dry);

  // След «какой исходник стал каким файлом»: media-plan.json. Без него
  // отбраковку кадра не к чему привязать, а вопрос «откуда эта обложка»
  // не имеет ответа.
  ctx.plan[productKey] = {
    image: next.image,
    files: Object.fromEntries(
      plan.map((s) => [s.name, { id: s.frame.id, source: s.frame.source, shot: s.frame.shot, layer: s.layer }]),
    ),
  };
  ctx.report.products.push({
    slug,
    category,
    studio: sliderPool.length,
    gallery: next.gallery.length,
    cover: generatedCover ? 'сгенерированная' : coverFrame ? coverFrame.source : 'плейсхолдер',
    result,
  });
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const only = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7) || null;

  if (!existsSync(INDEX_PATH)) {
    console.error('Нет media-index.json — сначала: node scripts/build-media-index.mjs');
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8')).items;
  const classification = existsSync(CLASSIFICATION_PATH)
    ? JSON.parse(readFileSync(CLASSIFICATION_PATH, 'utf8')).items
    : {};
  // Решения человека живут отдельным файлом, а не в .md, которые скрипт
  // переписывает целиком, — иначе первый повторный прогон стирал бы их.
  const assignments = readAssignments(STAGING);

  const frames = resolveFrames(index, { classification, assignments: assignments.product });
  const { demoted, skipped } = mergeOverrides(frames, readOverrides(STAGING), assignments);

  const byProduct = new Map();
  let orphan = 0;
  for (const frame of frames) {
    if (!frame.product) {
      orphan += 1;
      continue;
    }
    const productKey = resolveProductAlias(frame.product);
    if (!byProduct.has(productKey)) byProduct.set(productKey, []);
    byProduct.get(productKey).push(frame);
  }

  const ctx = { dry, assignments, plan: {}, report: { products: [], noEntry: [], converted: 0, reused: 0, removed: 0 } };
  for (const [productKey, list] of [...byProduct].sort()) {
    if (only && !productKey.endsWith(`/${only}`)) continue;
    await applyProduct(productKey, list, ctx);
  }

  // Товар, у которого не осталось ни одного кадра (человек открепил
  // последний), в byProduct не попадает — зачищаем честно: плейсхолдер,
  // пустые слои, файлы удалены (кроме сгенерированной cover.webp).
  for (const name of readdirSync(PRODUCTS_DIR).filter((f) => f.endsWith('.md'))) {
    const slug = name.replace(/\.md$/, '');
    if (only && slug !== only) continue;
    const file = path.join(PRODUCTS_DIR, name);
    const { data, body } = readEntry(file);
    if (byProduct.has(`${data.category}/${slug}`)) continue;
    const destDir = path.join(ASSETS_ROOT, 'products', data.category, slug);
    const generatedCover = existsSync(path.join(destDir, COVER_NAME));
    if (existsSync(destDir)) {
      for (const f of readdirSync(destDir)) {
        if (isJunk(f) || (generatedCover && f === COVER_NAME)) continue;
        ctx.report.removed += 1;
        if (!dry) unlinkSync(path.join(destDir, f));
      }
    }
    const next = {
      ...data,
      image: generatedCover ? `products/${data.category}/${slug}/${COVER_NAME}` : PLACEHOLDER_IMAGE,
      slider: [],
      gallery: [],
    };
    if (writeEntry(file, next, body, dry) !== 'same') (ctx.report.cleared ??= []).push(slug);
  }

  if (!dry) writeFileSync(path.join(STAGING, 'media-plan.json'), JSON.stringify(ctx.plan, null, 1));

  // --- отчёт -------------------------------------------------------------
  const r = ctx.report;
  console.log(`Кадров после схлопывания дублей: ${frames.length} (без привязки к товару: ${orphan})`);
  console.log(`Товаров обработано: ${r.products.length}, изменено файлов: ${r.products.filter((p) => p.result !== 'same').length}`);
  console.log(`Картинки: сконвертировано ${r.converted}, переиспользовано ${r.reused}, удалено лишних ${r.removed}`);
  const byCover = {};
  for (const p of r.products) byCover[p.cover] = (byCover[p.cover] ?? 0) + 1;
  console.log('Источник обложек:', Object.entries(byCover).map(([k, n]) => `${k} ${n}`).join(', ') || '—');
  if (r.cleared?.length) console.log(`Очищено до плейсхолдера (кадров не осталось): ${r.cleared.join(', ')}`);
  if (r.noEntry.length) console.log(`Кадры есть, а товара в каталоге нет (${r.noEntry.length}): ${r.noEntry.join(', ')}`);
  console.log(`Понижено отбраковкой в галерею: ${demoted}, отбраковка отменена решением человека: ${skipped}`);
  if (dry) console.log('\n[DRY] Ничего не записано.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
