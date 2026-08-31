/**
 * Слой кадра: обложка / слайдер / галерея.
 *
 * ОДНО ПРАВИЛО НА ДВА СКРИПТА. `build-sorter-data.mjs` показывает заказчику
 * текущее состояние сайта, `apply-media.mjs` это состояние создаёт. Разойдись
 * они хоть на шаг — сортировщик показывал бы не то, что на сайте, и правки
 * делались бы вслепую.
 *
 * РУЧНОЕ РЕШЕНИЕ ВСЕГДА БЬЁТ АВТОМАТИКУ. Автораскладка — это стартовая точка,
 * чтобы человек не расставлял 1062 кадра с нуля. Как только он тронул кадр в
 * сортировщике, его выбор записан в `.staging/assignments.json` и живёт там.
 * Поэтому повторный прогон `apply-media.mjs` не может стереть работу человека:
 * она хранится не в `.md`-файлах, которые скрипт переписывает, а в отдельном
 * файле, который он только читает.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LAYERS = ['cover', 'slider', 'gallery'];

// Алиасы «ключ пула → slug товара» живут в media.config.mjs — единственном
// проектном файле конвейера. Здесь только применение: сортировщик обязан
// группировать кадры по тем же товарам, что и раскладка, иначе кадры на
// сайте есть, а в сортировщике их не найти.
import { PRODUCT_ALIASES } from '../media.config.mjs';

export function resolveProductAlias(product) {
  return product ? (PRODUCT_ALIASES[product] ?? product) : product;
}

/**
 * Ручная отбраковка (`.staging/media-overrides.json`) — вливается в кадры, а
 * не исключает их. НИЧЕГО НЕ ВЫКИДЫВАЕТСЯ МОЛЧА: помеченный кадр через
 * `layerFor` уезжает в конец галереи, и сортировщик показывает ровно то же,
 * что сайт. Прежняя версия исключала кадры целиком — и сортировщик показывал
 * кадры, которых на странице нет; заказчик сообщил об этом как о пропаже.
 *
 * Явное решение человека старше отбраковки: тронутый в сортировщике кадр
 * флаги не получает.
 */
export function readOverrides(stagingDir) {
  const file = path.join(stagingDir, 'media-overrides.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export function mergeOverrides(frames, overrides, assignments) {
  const explicitIds = new Set([
    ...Object.keys(assignments.product ?? {}),
    ...Object.keys(assignments.layer ?? {}),
  ]);
  let demoted = 0;
  let skipped = 0;
  for (const frame of frames) {
    const ids = frame.groupIds ?? [frame.id];
    const hit = ids.map((id) => overrides[id]).find(Boolean);
    if (!hit) continue;
    if (ids.some((id) => explicitIds.has(id))) {
      skipped += 1;
      continue;
    }
    frame.watermark = true; // → layerFor отправит в галерею, обложкой не станет
    frame.note = hit.why ?? frame.note;
    demoted += 1;
  }
  return { demoted, skipped };
}

/**
 * Кадры, которые автоматика отправляет ВНИЗ, в галерею: там, где герой кадра
 * не изделие, а обстановка, событие или картинка из компьютера.
 *
 * Всё остальное — витрина. Раньше в слайдер пускалась только метка `studio`,
 * и это опустошило слайдер у всех 124 товаров: `studio` получали лишь кадры
 * на чистом фоне (25 на весь архив), а готовое изделие, снятое в цеху, шло
 * вниз вместе с браком. Цех — это каркас без обивки и упаковка, а не «снято
 * не в студии».
 */
export const GALLERY_SHOTS = new Set(['interior', 'event', 'render', 'screenshot']);

/**
 * Порядок внутри слайдера: чистая предметка → каталожные кадры старого сайта
 * (метки нет) → изделие в интерьере фабрики. Внутри группы крупное вперёд.
 */
export const SLIDER_RANK = { studio: 0, workshop: 2 };
export const SLIDER_RANK_UNCLASSIFIED = 1;

/**
 * Читает `.staging/assignments.json` — решения человека из сортировщика.
 *
 * Формат:
 *   { "version": 2, "frames": { "<id кадра>": { "product": "sofa/divan-nova",
 *                                               "layer": "slider" } } }
 *
 * Возвращает две плоские карты, потому что потребителям нужны разные вещи:
 * `resolveFrames` — только привязка к товару (и до схлопывания дублей),
 * раскладка — только слой.
 */
export function readAssignments(stagingDir) {
  const file = path.join(stagingDir, 'assignments.json');
  const empty = { product: {}, layer: {} };
  if (!existsSync(file)) return empty;

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const frames = raw.frames ?? {};
  const out = { product: {}, layer: {} };
  for (const [id, value] of Object.entries(frames)) {
    // `product: null` — это НЕ «поле не заполнено», а явное решение «открепить
    // от товара»: кнопка «Убрать из товара» в сортировщике пишет именно null,
    // и оно обязано перебить автопривязку кадра по папке-источнику. Поэтому
    // различаем «ключа нет» и «ключ есть со значением null».
    if (value && 'product' in value) out.product[id] = value.product;
    if (value?.layer && LAYERS.includes(value.layer)) out.layer[id] = value.layer;
  }
  return out;
}

/**
 * Слой кадра. Ручное решение (по любому члену группы дублей — это один и тот
 * же снимок) побеждает; иначе автоматика по типу съёмки.
 *
 * Отбракованный кадр всегда вниз: и `usable: false` разметки, и водяной знак
 * означают «в витрине этому не место».
 */
export function layerFor(frame, assignments = { layer: {} }) {
  const ids = frame.groupIds ?? [frame.id];
  for (const id of ids) {
    if (assignments.layer[id]) return assignments.layer[id];
  }
  if (frame.usable === false || frame.watermark === true) return 'gallery';
  return GALLERY_SHOTS.has(frame.shot) ? 'gallery' : 'slider';
}
