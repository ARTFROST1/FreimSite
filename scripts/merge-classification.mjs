#!/usr/bin/env node
/**
 * Сборка авторазметки архива (docs/recipes/photo-archive.md, шаг 3):
 * `.staging/{classification,media-classification}/NNN.json` → одним файлом
 * `.staging/classification.json`, который читают `apply-media.mjs`,
 * `build-sorter-data.mjs` и `build-media-collages.mjs`.
 *
 * ПОЧЕМУ РАЗМЕТКА ЛЕЖИТ ПО ФАЙЛУ НА КОЛЛАЖ
 * ----------------------------------------
 * Первый заход разметки на живом проекте писал результат одним куском в
 * конце — и оказался выдумкой: исполнитель посмотрел часть контактных листов,
 * а остальные «разметил по закономерностям», записав сотни живых фотографий
 * в компьютерные визуализации. Отчёт при этом выглядел убедительно — цифры
 * сходились, категории были правдоподобны.
 *
 * Файл-на-коллаж — это защита от повторения: покрытие проверяется механически
 * (файл на каждый лист × ровно свои 9 кадров), а не со слов исполнителя.
 * Поэтому этот скрипт не просто склеивает — он ВАЛИДИРУЕТ и отказывается
 * писать результат, если состав не сходится с индексом листов.
 *
 * ЧТО ПРОВЕРЯЕТСЯ
 * ---------------
 *   - для набора `archive` — что пул россыпи зарегистрирован в POOLS ровно
 *     с тем dir, под который уже пересчитаны id разметки (см. archivePoolDir());
 *   - есть файл на каждый коллаж из индекса;
 *   - в файле ровно те кадры, что в его ячейках (без лишних и без пропусков);
 *   - у каждого кадра заполнены category / shot / watermark / usable;
 *   - значения category и shot — из допустимого списка (CLASSIFICATION_CATEGORIES
 *     в media.config.mjs + типы съёмки из lib/media-layers.mjs);
 *   - ни один кадр не размечен дважды в разных файлах.
 *
 * ФЛАГИ
 * -----
 *   --set=archive|main  какой набор коллажей мержить (см. SETS ниже)
 *   --dry               напечатать отчёт, ничего не писать
 *   --partial           разрешить неполное покрытие (для промежуточных
 *                       прогонов, пока часть коллажей ещё размечается)
 *
 * Запуск:
 *   node scripts/merge-classification.mjs --set=archive
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, STAGING, CLASSIFICATION_CATEGORIES, POOLS } from './media.config.mjs';
import { GALLERY_SHOTS } from './lib/media-layers.mjs';

/**
 * Путь, который получит POOLS-пул россыпи в общем индексе — так же, как его
 * посчитает `build-media-index.mjs`, обходя `.staging/gallery/full`
 * (id там — путь от REPO_ROOT, а `STAGING` всегда `REPO_ROOT/.staging`, см.
 * media.config.mjs). Единая точка вычисления: её же использует `keyFor`
 * ниже и рантайм-проверка в `main()`, и её же импортирует
 * `build-media-collages.mjs` для своей проверки — чтобы оба места не
 * разъехались, если кто-то передвинет STAGING.
 */
export function archivePoolDir() {
  return path.join(path.relative(REPO_ROOT, STAGING), 'gallery', 'full');
}

/** Есть ли в POOLS пул с этим dir (сравнение по нормализованному пути — опечатка в слэшах не должна давать ложный «не найден»). */
export function isPoolRegistered(pools, dir) {
  const normalized = path.normalize(dir);
  return pools.some((p) => path.normalize(p.dir) === normalized);
}

/**
 * Наборы коллажей. `archive` — первый заход по россыпи без привязки к товару
 * (`prepare-gallery.mjs` → `build-collages.mjs`). `main` — второй заход, по
 * кадрам общего индекса, которым разметка не досталась по группе дублей
 * (`build-media-collages.mjs`).
 *
 * Результат ОБА пишут в один `.staging/classification.json`: слои раскладки
 * читают разметку по id кадра и не знают, каким заходом она получена. Поэтому
 * запись сливающая — набор дописывает свои кадры, не стирая чужие.
 *
 * `keyFor` — под каким id кадр попадёт в `classification.json`. Для `main`
 * id уже настоящий (из `media-index.json`, посчитан `build-media-index.mjs`),
 * менять нечего. Для `archive` в `collages/index.json` лежат id из МАНИФЕСТА
 * `prepare-gallery.mjs` (слаг+md5) — они не совпадают с id, которые присвоит
 * `build-media-index.mjs`, когда `.staging/gallery/full` станет обычным
 * POOLS-пулом (см. `archivePoolDir()` выше). Без пересчёта разметка архива
 * осталась бы «сиротой»: она есть в файле, но `resolveFrames` её не находит —
 * кадр снова выглядел бы неразмеченным. Поэтому id пересчитывается заранее,
 * а `main()` ниже проверяет в рантайме, что пул и правда зарегистрирован
 * ровно с этим dir — не полагаясь на то, что документацию прочли.
 */
const SETS = {
  archive: {
    index: 'collages/index.json',
    parts: 'classification',
    keyFor: (id) => `${path.join(archivePoolDir(), `${id}.webp`)}`,
  },
  main: {
    index: 'media-collages/index.json',
    parts: 'media-classification',
    keyFor: (id) => id,
  },
};

const setName = (process.argv.find((a) => a.startsWith('--set=')) ?? '--set=archive').slice(6);
const SET = SETS[setName];
if (!SET) {
  console.error(`Неизвестный набор "${setName}". Доступны: ${Object.keys(SETS).join(', ')}`);
  process.exit(1);
}

const INDEX = path.join(STAGING, SET.index);
const PARTS_DIR = path.join(STAGING, SET.parts);
const OUT = path.join(STAGING, 'classification.json');

/**
 * `shot`: студийная предметка и цех могут попасть в слайдер (см.
 * SLIDER_RANK в lib/media-layers.mjs), остальное — только в галерею
 * (GALLERY_SHOTS оттуда же). Список один на оба скрипта, чтобы не разъехаться.
 */
const SHOTS = new Set(['studio', 'workshop', ...GALLERY_SHOTS]);

function partFile(collage) {
  return path.join(PARTS_DIR, collage.replace(/\.webp$/, '.json'));
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const partial = argv.includes('--partial');

  if (!CLASSIFICATION_CATEGORIES.length) {
    console.error('CLASSIFICATION_CATEGORIES пуст — заполните scripts/media.config.mjs (см. docs/recipes/photo-archive.md).');
    process.exit(1);
  }
  const CATEGORIES = new Set(CLASSIFICATION_CATEGORIES);

  // Гвард вместо «доверяй документации»: если пул россыпи не зарегистрирован
  // (или зарегистрирован не с тем dir — опечатка, лишний/недостающий слэш),
  // то id, которые keyFor уже пересчитал под archivePoolDir(), никогда не
  // совпадут с тем, что построит build-media-index.mjs — разметка молча
  // станет «сиротой». Проверяем ДО записи, а не полагаемся на то, что кто-то
  // сверился с рецептом руками.
  if (setName === 'archive') {
    const dir = archivePoolDir();
    if (!isPoolRegistered(POOLS, dir)) {
      console.error(
        `POOLS (scripts/media.config.mjs) не содержит пул с dir: '${dir}'. ` +
          `Без него resolveFrames не найдёт разметку набора «archive» — её id уже пересчитаны ` +
          `под этот путь. Добавьте { name: 'archive', dir: '${dir}', attribution: 'none' } в POOLS ` +
          `(можно до появления самой папки — build-media-index.mjs просто увидит её пустой, пока ` +
          `prepare-gallery.mjs её не заполнит) и повторите прогон.`,
      );
      process.exit(1);
    }
  }

  if (!existsSync(INDEX)) {
    console.error(`Нет ${path.relative(STAGING, INDEX)} — сначала соберите коллажи набора «${setName}».`);
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(INDEX, 'utf8'));

  const items = {};
  const seenIn = new Map(); // id кадра → в каком коллаже уже встретился
  const missingParts = [];
  const problems = [];

  for (const entry of index) {
    const file = partFile(entry.collage);
    if (!existsSync(file)) {
      missingParts.push(entry.collage);
      continue;
    }

    let part;
    try {
      part = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      problems.push(`${entry.collage}: файл не читается как JSON (${err.message})`);
      continue;
    }

    const expected = new Set(entry.cells.map((c) => c.id));
    const got = new Set(Object.keys(part.items ?? {}));

    for (const id of expected) {
      if (!got.has(id)) problems.push(`${entry.collage}: не размечен кадр ${id}`);
    }
    for (const id of got) {
      if (!expected.has(id)) problems.push(`${entry.collage}: лишний кадр ${id}`);
    }

    for (const [id, value] of Object.entries(part.items ?? {})) {
      if (!expected.has(id)) continue;
      const prev = seenIn.get(id);
      if (prev) {
        problems.push(`кадр ${id} размечен дважды: ${prev} и ${entry.collage}`);
        continue;
      }
      if (!CATEGORIES.has(value.category)) {
        problems.push(`${entry.collage} / ${id}: неизвестная категория "${value.category}"`);
        continue;
      }
      if (!SHOTS.has(value.shot)) {
        problems.push(`${entry.collage} / ${id}: неизвестный тип съёмки "${value.shot}"`);
        continue;
      }
      seenIn.set(id, entry.collage);
      items[SET.keyFor(id)] = {
        category: value.category,
        shot: value.shot,
        watermark: value.watermark === true,
        usable: value.usable !== false,
        note: typeof value.note === 'string' ? value.note : '',
      };
    }
  }

  // --- отчёт ---------------------------------------------------------------
  const total = index.reduce((n, e) => n + e.cells.length, 0);
  const tally = (key) =>
    Object.entries(
      Object.values(items).reduce((acc, v) => {
        acc[v[key]] = (acc[v[key]] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]);

  console.log(
    `Разметка (${setName}): ${Object.keys(items).length} из ${total} кадров, ` +
      `${index.length - missingParts.length} из ${index.length} коллажей`,
  );
  console.log('  категории:', tally('category').map(([k, n]) => `${k} ${n}`).join(', '));
  console.log('  съёмка:   ', tally('shot').map(([k, n]) => `${k} ${n}`).join(', '));
  console.log(
    `  с водяным знаком: ${Object.values(items).filter((v) => v.watermark).length}, ` +
      `отбраковано: ${Object.values(items).filter((v) => !v.usable).length}`,
  );

  if (missingParts.length) {
    console.log(`  нет разметки у ${missingParts.length} коллажей: ${missingParts.join(', ')}`);
  }
  if (problems.length) {
    console.error(`\nПроблемы (${problems.length}):`);
    for (const p of problems.slice(0, 30)) console.error(`  - ${p}`);
    if (problems.length > 30) console.error(`  … и ещё ${problems.length - 30}`);
  }

  // --- запись --------------------------------------------------------------
  if (problems.length) {
    console.error('\nРезультат не записан: сначала почините перечисленное выше.');
    process.exit(1);
  }
  if (missingParts.length && !partial) {
    console.error('\nРезультат не записан: покрытие неполное. Прогон с --partial запишет как есть.');
    process.exit(1);
  }
  if (dry) {
    console.log('\n[DRY] Ничего не записано.');
    return;
  }

  // Слияние, а не перезапись: наборы `archive` и `main` пишут в один файл, и
  // прогон одного не должен стирать кадры другого. Свежая разметка набора
  // побеждает — повторный прогон после правки листа обязан её применить.
  mkdirSync(path.dirname(OUT), { recursive: true });
  const existing = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')).items ?? {}) : {};
  const merged = { ...existing, ...items };
  const text = JSON.stringify({ version: 1, items: merged }, null, 1);
  writeFileSync(OUT, text, 'utf8');
  console.log(
    `\nЗаписано: ${path.relative(REPO_ROOT, OUT)} (${(text.length / 1024) | 0} КБ), ` +
      `кадров в файле ${Object.keys(merged).length} (набор «${setName}» дал ${Object.keys(items).length})`,
  );
}

// Запускаем main() только при прямом вызове файла: build-media-collages.mjs
// импортирует archivePoolDir()/isPoolRegistered() из этого модуля для своей
// проверки, и импорт не должен попутно гонять весь merge.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
