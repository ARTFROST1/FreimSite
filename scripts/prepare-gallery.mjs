#!/usr/bin/env node
/**
 * Первый шаг работы с россыпью (docs/recipes/photo-archive.md): конвертация
 * сырого архива клиента (`GALLERY_RAW_DIR` в media.config.mjs) в браузеро-
 * читаемые превью + манифест, из которого `build-collages.mjs` строит
 * контактные листы для разметки.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ШАГ ДО ИНДЕКСА. `build-media-index.mjs` умеет читать HEIC
 * (через `lib/readable-image.mjs`), но не видео и не выдаёт человеку ничего
 * смотрибельного — только хеши. Пока архив не размечен и не привязан к
 * товару, класть его в POOLS рано: сначала нужно превью, по которому человек
 * вообще может понять, что на кадре. Этот скрипт — тот самый предварительный
 * проход: россыпь → `.staging/gallery/{full,thumb,video}` + `manifest.json`.
 *
 * Цепочки конвертации (проверены на живом архиве клиента — несколько сотен
 * файлов, несколько гигабайт):
 *
 *   jpg/jpeg/png/webp → sharp: rotate() + resize inside + webp q82
 *   HEIC, DNG         → sips -s format jpeg во временный файл → та же цепочка sharp
 *   MOV/MP4           → ffmpeg → webm VP9 (crf 34, без звука)
 *                       + постер: ffmpeg -frames:v 1 → png → sharp → webp
 *
 * Тупики, проверенные и отброшенные — не пробовать заново:
 *   - sharp не читает HEIC напрямую в типичной сборке (heif числится в форматах,
 *     на файле падает);
 *   - sips не умеет писать webp — молча не создаёт файл;
 *   - `magick` для DNG требует darktable-cli, которого обычно нет в системе;
 *   - ffmpeg часто не кодирует webp напрямую («Default encoder for format webp
 *     is probably disabled»), поэтому постер видео идёт через промежуточный png.
 *
 * Решения, которые стоит знать при чтении кода:
 *
 *   - ID кадра = слаг имени файла + первые 8 символов md5. Слаг даёт читаемость
 *     в логах и в сетке контактных листов, хеш — устойчивость: имена в архиве
 *     повторяются (одно и то же IMG_XXXX лежит и в корне, и в подпапке), а
 *     содержимое различает только md5. Идентификатор стабилен между прогонами,
 *     поэтому идемпотентность = проверка существования выходного файла.
 *     СТАБИЛЕН — после первого прогона на него ссылается разметка
 *     (`.staging/classification.json`), менять схему id нельзя.
 *
 *   - width/height в манифесте — размеры сгенерированного превью `full`, а не
 *     исходника: соотношение сторон то же, а размеры HEIC/DNG стоят отдельной
 *     конвертации через sips, которую на повторном прогоне мы как раз не
 *     делаем. Меньше работы — тот же результат.
 *
 *   - Дедуп по md5: одинаковое содержимое даёт одну запись манифеста, все
 *     остальные пути складываются в `duplicatePaths`. Терять их нельзя —
 *     заказчик может искать кадр по знакомому имени файла.
 *
 * Идемпотентность: готовые выходные файлы не переделываются. Манифест
 * переписывается целиком каждый прогон (он дёшев и должен отражать текущее
 * состояние папки).
 *
 * Запуск:
 *   node scripts/prepare-gallery.mjs --dry     # план работ, ничего не пишет
 *   node scripts/prepare-gallery.mjs           # полный прогон
 *   node scripts/prepare-gallery.mjs --jobs=2  # ограничить параллелизм (по умолчанию 4)
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { REPO_ROOT, STAGING, GALLERY_RAW_DIR, GALLERY_EXCLUDED_FOLDERS } from './media.config.mjs';

const execFileAsync = promisify(execFile);

const GALLERY_SRC = path.join(REPO_ROOT, GALLERY_RAW_DIR);
const OUT_ROOT = path.join(STAGING, 'gallery');
const OUT_FULL = path.join(OUT_ROOT, 'full');
const OUT_THUMB = path.join(OUT_ROOT, 'thumb');
const OUT_VIDEO = path.join(OUT_ROOT, 'video');
const MANIFEST = path.join(OUT_ROOT, 'manifest.json');

const FULL_WIDTH = 1600;
const FULL_QUALITY = 82;
const THUMB_WIDTH = 400;
const THUMB_QUALITY = 75;

/**
 * Видео: длинная сторона не больше 1280 и не больше 30 кадров/с.
 *
 * Выражение `scale='min(1280,iw)':-2` держится только для горизонтальных
 * клипов: архивы клиентов почти всегда сняты вертикально, и там оно
 * ограничивает ширину, а высоту отпускает — 2160×3840 превращается в
 * 1280×2276, то есть кадр ВЫШЕ 1080p. `if(gt(iw,ih), …)` ограничивает именно
 * длинную сторону независимо от ориентации: на замере на живом архиве это
 * дало на порядок меньший размер файла и заметно более быстрое кодирование
 * против наивного варианта. `min(source_fps,30)` не разгоняет 24-кадровые
 * исходники.
 */
const VIDEO_SCALE = "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))',fps='min(source_fps,30)'";

/** Читаются sharp'ом напрямую. */
const EXT_PHOTO_DIRECT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
/** sharp не открывает; сначала sips -s format jpeg. */
const EXT_PHOTO_VIA_SIPS = new Set(['.heic', '.dng']);
const EXT_VIDEO = new Set(['.mov', '.mp4']);

const isJunk = (name) => name.startsWith('._') || name === '.DS_Store';

const numericSort = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

const RU = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
const LAT = ['a', 'b', 'v', 'g', 'd', 'e', 'e', 'zh', 'z', 'i', 'y', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u', 'f', 'h', 'c', 'ch', 'sh', 'sch', '', 'y', '', 'e', 'yu', 'ya'];

/** Имя файла → латинский слаг: «Кровать Телек» → `krovat-telek`. */
function slugify(name) {
  const translit = [...name.toLowerCase()].map((ch) => {
    const i = RU.indexOf(ch);
    return i === -1 ? ch : LAT[i];
  }).join('');
  const slug = translit.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'media';
}

async function md5File(filePath) {
  const hash = crypto.createHash('md5');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

function classify(ext) {
  if (EXT_PHOTO_DIRECT.has(ext)) return { kind: 'photo', viaSips: false };
  if (EXT_PHOTO_VIA_SIPS.has(ext)) return { kind: 'photo', viaSips: true };
  if (EXT_VIDEO.has(ext)) return { kind: 'video', viaSips: false };
  return null;
}

/**
 * Обходит архив: возвращает файлы к обработке и файлы из исключённых папок
 * отдельно. Обход рекурсивный, даже если у вашего архива нет вложенности —
 * чтобы не сломаться, если клиент дошлёт вложенную структуру.
 */
function collectFiles() {
  const excludedNames = new Set(GALLERY_EXCLUDED_FOLDERS.map((f) => f.name));
  const wanted = [];
  const excluded = [];
  const unsupported = [];
  let junk = 0;

  const walk = (absDir, relDir, insideExcluded) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const name = entry.name;
      const rel = relDir ? `${relDir}/${name}` : name;
      if (entry.isDirectory()) {
        walk(path.join(absDir, name), rel, insideExcluded || excludedNames.has(rel));
        continue;
      }
      if (!entry.isFile()) continue;
      if (isJunk(name)) {
        junk++;
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      const type = classify(ext);
      if (!type) {
        unsupported.push(rel);
        continue;
      }
      const file = { rel, abs: path.join(absDir, name), name, ext, ...type, folder: relDir };
      (insideExcluded ? excluded : wanted).push(file);
    }
  };

  walk(GALLERY_SRC, '', false);
  wanted.sort((a, b) => numericSort(a.folder, b.folder) || numericSort(a.name, b.name));
  return { wanted, excluded, unsupported, junk };
}

/** Конвертирует уже читаемый sharp'ом файл в пару full+thumb. Возвращает размеры full. */
async function writePreviews(sharpInput, id) {
  const full = await sharp(sharpInput)
    .rotate()
    .resize({ width: FULL_WIDTH, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: FULL_QUALITY })
    .toFile(path.join(OUT_FULL, `${id}.webp`));

  await sharp(sharpInput)
    .rotate()
    .resize({ width: THUMB_WIDTH, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toFile(path.join(OUT_THUMB, `${id}.webp`));

  return { width: full.width, height: full.height };
}

/** Фото: HEIC/DNG предварительно проходят через sips во временный jpeg. */
async function convertPhoto(file, id) {
  if (!file.viaSips) return writePreviews(file.abs, id);

  const tmp = path.join(os.tmpdir(), `prepare-gallery-${crypto.randomUUID()}.jpg`);
  try {
    await execFileAsync('sips', ['-s', 'format', 'jpeg', file.abs, '--out', tmp]);
    if (!existsSync(tmp)) throw new Error('sips не создал jpeg (файл повреждён или формат не поддержан)');
    return await writePreviews(tmp, id);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Видео: webm VP9 + постер из первого кадра.
 * `-row-mt 1 -cpu-used 4` не меняют цепочку, а только скорость libvpx: на
 * дефолтном `cpu-used 0` тот же клип кодируется вдвое дольше при том же
 * размере файла.
 */
async function convertVideo(file, id) {
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-i', file.abs,
    '-vf', VIDEO_SCALE,
    '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-an',
    '-row-mt', '1', '-cpu-used', '4',
    path.join(OUT_VIDEO, `${id}.webm`),
  ]);

  const tmp = path.join(os.tmpdir(), `prepare-gallery-${crypto.randomUUID()}.png`);
  try {
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-i', file.abs, '-frames:v', '1', tmp]);
    if (!existsSync(tmp)) throw new Error('ffmpeg не отдал кадр для постера');
    return await writePreviews(tmp, id);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const outputsFor = (id, kind) => [
  path.join(OUT_FULL, `${id}.webp`),
  path.join(OUT_THUMB, `${id}.webp`),
  ...(kind === 'video' ? [path.join(OUT_VIDEO, `${id}.webm`)] : []),
];

/** Простой пул: N задач одновременно, порядок результатов не важен. */
async function runPool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const jobsArg = args.find((a) => a.startsWith('--jobs='));
  const jobs = Math.max(1, Number(jobsArg?.split('=')[1]) || 4);

  if (!GALLERY_RAW_DIR) {
    console.error('GALLERY_RAW_DIR пуст — заполните scripts/media.config.mjs (см. docs/recipes/photo-archive.md).');
    process.exit(1);
  }
  if (!existsSync(GALLERY_SRC)) {
    console.error(`Нет папки архива: ${GALLERY_SRC}`);
    process.exit(1);
  }

  console.error(`Архив: ${GALLERY_SRC}`);
  const { wanted, excluded, unsupported, junk } = collectFiles();
  console.error(`Найдено файлов: ${wanted.length} к обработке, ${excluded.length} в исключённых папках, ` +
    `${unsupported.length} неподдерживаемых, ${junk} мусорных (.DS_Store / ._*)`);
  for (const f of GALLERY_EXCLUDED_FOLDERS) console.error(`  исключено: «${f.name}» — ${f.reason}`);
  for (const rel of unsupported) console.error(`  ! неизвестное расширение, пропущено: ${rel}`);

  console.error('Считаю md5 (нужен и для дедупа, и для идентификаторов)…');
  const blockedHashes = new Set();
  await runPool(excluded, jobs, async (file) => {
    blockedHashes.add(await md5File(file.abs));
  });
  await runPool(wanted, jobs, async (file) => {
    file.md5 = await md5File(file.abs);
  });

  // Дедуп: первый файл в отсортированном порядке становится записью манифеста,
  // остальные с тем же md5 — списком duplicatePaths при нём.
  const byHash = new Map();
  const blockedElsewhere = [];
  let duplicateCount = 0;
  for (const file of wanted) {
    if (blockedHashes.has(file.md5)) {
      blockedElsewhere.push(file.rel);
      continue;
    }
    const existing = byHash.get(file.md5);
    if (existing) {
      existing.duplicatePaths.push(file.rel);
      duplicateCount++;
      continue;
    }
    byHash.set(file.md5, { ...file, id: `${slugify(path.basename(file.name, path.extname(file.name)))}-${file.md5.slice(0, 8)}`, duplicatePaths: [] });
  }

  if (blockedElsewhere.length) {
    console.error(`  ! ${blockedElsewhere.length} файл(ов) вне исключённых папок совпадают по md5 с исключённым содержимым, тоже отброшены:`);
    for (const rel of blockedElsewhere) console.error(`      ${rel}`);
  }

  const unique = [...byHash.values()];
  const ids = new Set();
  for (const item of unique) {
    if (ids.has(item.id)) throw new Error(`Коллизия идентификатора ${item.id} (${item.rel}) — так быть не должно`);
    ids.add(item.id);
  }

  const photos = unique.filter((f) => f.kind === 'photo');
  const videos = unique.filter((f) => f.kind === 'video');
  const pending = unique.filter((f) => !outputsFor(f.id, f.kind).every(existsSync));

  console.error(
    `\nПлан: уникальных ${unique.length} (фото ${photos.length}, видео ${videos.length}), ` +
    `дублей схлопнуто ${duplicateCount}, уже готово ${unique.length - pending.length}, к конвертации ${pending.length}`,
  );
  const byExt = new Map();
  for (const f of pending) byExt.set(f.ext, (byExt.get(f.ext) ?? 0) + 1);
  if (byExt.size) {
    console.error('К конвертации по расширениям: ' + [...byExt].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(', '));
  }

  if (dry) {
    console.error(`\n--dry: ничего не записано. Выход был бы в ${OUT_ROOT}`);
    return;
  }

  for (const dir of [OUT_FULL, OUT_THUMB, OUT_VIDEO]) mkdirSync(dir, { recursive: true });

  const failures = [];
  let converted = 0;
  let done = 0;
  // Видео вперёд: они самые долгие, так пул не простаивает в конце на одном ffmpeg.
  const queue = [...videos, ...photos];

  await runPool(queue, jobs, async (item) => {
    const outputs = outputsFor(item.id, item.kind);
    const label = `${item.rel} → ${item.id}`;
    try {
      if (outputs.every(existsSync)) {
        const meta = await sharp(path.join(OUT_FULL, `${item.id}.webp`)).metadata();
        item.dimensions = { width: meta.width, height: meta.height };
      } else {
        item.dimensions = item.kind === 'video' ? await convertVideo(item, item.id) : await convertPhoto(item, item.id);
        converted++;
      }
    } catch (err) {
      // Частичный результат хуже отсутствующего: он выглядел бы готовым на следующем прогоне.
      for (const out of outputs) rmSync(out, { force: true });
      failures.push({ rel: item.rel, message: String(err.message ?? err).split('\n').slice(-1)[0].trim() });
      console.error(`  [ОШИБКА] ${label}: ${failures.at(-1).message}`);
    }
    done++;
    if (done % 25 === 0 || done === queue.length) {
      console.error(`  … ${done}/${queue.length} (сконвертировано ${converted}, ошибок ${failures.length})`);
    }
  });

  const failed = new Set(failures.map((f) => f.rel));
  const manifest = unique
    .filter((item) => !failed.has(item.rel))
    .sort((a, b) => numericSort(a.folder, b.folder) || numericSort(a.name, b.name))
    .map((item) => ({
      id: item.id,
      sourcePath: item.rel,
      sourceFolder: item.folder,
      kind: item.kind,
      width: item.dimensions.width,
      height: item.dimensions.height,
      md5: item.md5,
      thumb: `thumb/${item.id}.webp`,
      full: `full/${item.id}.webp`,
      ...(item.kind === 'video' ? { video: `video/${item.id}.webm` } : {}),
      ...(item.duplicatePaths.length ? { duplicatePaths: item.duplicatePaths } : {}),
    }));

  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  console.error('\n=== Итог ===');
  console.error(`Записей в манифесте: ${manifest.length} (фото ${manifest.filter((m) => m.kind === 'photo').length}, видео ${manifest.filter((m) => m.kind === 'video').length})`);
  console.error(`Сконвертировано в этот прогон: ${converted}, пропущено как готовое: ${unique.length - pending.length}`);
  console.error(`Дублей схлопнуто: ${duplicateCount}; записей с дублями: ${manifest.filter((m) => m.duplicatePaths).length}`);
  console.error(`Отброшено по исключениям: ${excluded.length} в папках + ${blockedElsewhere.length} копий вне них`);
  console.error(`Ошибок: ${failures.length}`);
  for (const f of failures) console.error(`  ${f.rel}: ${f.message}`);
  console.error(`Размер выхода: ${mb(dirSize(OUT_ROOT))} (full ${mb(dirSize(OUT_FULL))}, thumb ${mb(dirSize(OUT_THUMB))}, video ${mb(dirSize(OUT_VIDEO))})`);
  console.error(`Манифест: ${MANIFEST}`);
  console.error(
    `\nДальше: node scripts/build-collages.mjs → разметить листы → ` +
    `node scripts/merge-classification.mjs --set=archive. Когда разметка готова, добавьте в POOLS ` +
    `(media.config.mjs) пул { dir: '.staging/gallery/full', attribution: 'none' } — ИМЕННО с этим dir: ` +
    `merge-classification уже пересчитал id разметки под этот путь, другой dir её потеряет.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
