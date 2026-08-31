/**
 * Дедуп кадров по перцептивному хешу и перенос известного внутри группы.
 * Спека `docs/history/specs/2026-08-11-media-layers-design.md`, §Конвейер п.2.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Одну и ту же группировку должны видеть два скрипта:
 * `build-media-collages.mjs` (что ещё осталось разметить) и `apply-media.mjs`
 * (что куда положить). Если бы каждый группировал сам, они разошлись бы на
 * первой же правке порога — а порог тут не косметика: он решает, считаются ли
 * два кадра одним снимком.
 *
 * ПОЧЕМУ НЕ md5. Пулы содержат ПЕРЕЖАТЫЕ копии одних и тех же снимков:
 * `главная/…/IMG_8640.HEIC` 4032×3024 и `.staging/gallery/full/img-8640-….webp`
 * 1600×1200 — это один кадр, но байты разные и md5 не совпадёт. dHash-64
 * (см. `build-media-index.mjs`) переживает пережатие и ресайз.
 *
 * ЧТО ДАЁТ ГРУППИРОВКА СВЕРХ ДЕДУПА. Разные пулы знают о кадре РАЗНОЕ:
 *   - «главная» знает ТОВАР (папка названа моделью), но не знает типа кадра;
 *   - «архив» знает ТИП КАДРА (`classification.json`), но не знает товара.
 * Пересечение пулов — 85 групп. Склеив их, каждая сторона получает то, чего
 * у неё не было, без единого клика в сортировщике.
 */

/**
 * Порог различия в битах (из 64). 6 подобран по фактическим данным: пережатие
 * 4032→1600 с потерей качества даёт 0–4 бита, а разные ракурсы одного дивана —
 * 12 и выше. Поднимать опасно: на 8+ начинают слипаться соседние кадры серии,
 * снятые с шагом в полметра, и один из них потеряется как «дубль».
 */
export const HAMMING_THRESHOLD = 6;

const POPCOUNT = new Uint8Array(65536);
for (let i = 1; i < 65536; i++) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

/** hex-16 → четыре 16-битных слова, чтобы расстояние считалось по таблице. */
function words(hex) {
  return [
    parseInt(hex.slice(0, 4), 16),
    parseInt(hex.slice(4, 8), 16),
    parseInt(hex.slice(8, 12), 16),
    parseInt(hex.slice(12, 16), 16),
  ];
}

function hamming(a, b) {
  return (
    POPCOUNT[a[0] ^ b[0]] + POPCOUNT[a[1] ^ b[1]] + POPCOUNT[a[2] ^ b[2]] + POPCOUNT[a[3] ^ b[3]]
  );
}

/**
 * Группы одинаковых кадров. Транзитивное замыкание (союз-найти): если A≈B и
 * B≈C, все трое — одна группа, даже когда A и C сами по себе за порогом.
 * Так серия пережатий одного снимка не распадается на цепочку пар.
 *
 * 1204 кадра → ~700 тыс. пар, каждая пара это четыре обращения к таблице:
 * доли секунды, поэтому честный двойной цикл без бакетирования по префиксу.
 */
export function groupByPerceptualHash(items, threshold = HAMMING_THRESHOLD) {
  const w = items.map((i) => words(i.phash));
  const parent = items.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (hamming(w[i], w[j]) <= threshold) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[b] = a;
      }
    }
  }
  const byRoot = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(item);
  });
  return [...byRoot.values()];
}

/**
 * Кто в группе побеждает: максимальная площадь кадра. При равной площади
 * приоритет пула `main > archive > oldsite` — «главная» хранит оригинал
 * (HEIC с камеры), архив уже пережат, скрап пережат дважды и обрезан.
 */
// Ранг пула приезжает с кадром из media.config.mjs (POOLS[].rank): 0 —
// авторская съёмка, дальше по убыванию качества источника.

export function pickCanonical(group) {
  return [...group].sort((a, b) => {
    const areaDiff = b.width * b.height - a.width * a.height;
    if (areaDiff !== 0) return areaDiff;
    return (a.rank ?? 9) - (b.rank ?? 9);
  })[0];
}

/**
 * Свести индекс к «по одному кадру на снимок», раздав каждому всё, что о нём
 * знает любой член его группы.
 *
 * `classification` — карта `id → {category, shot, watermark, usable, note}`
 * (формат `.staging/gallery/classification.json`, ключи — id кадров архива).
 * `assignments` — карта `id → 'cat/slug'` из сортировщика; пока её нет,
 * привязку дают только «главная» и скрап, где товар известен из пути.
 *
 * Возвращает канонические кадры, у каждого:
 *   `product`  — 'cat/slug' или null
 *   `shot`     — 'studio' | 'interior' | … | null
 *   `duplicates` — сколько кадров схлопнулось в этот (для отчёта)
 *   `sourcesInGroup` — из каких пулов пришла группа (для отчёта)
 */
export function resolveFrames(items, { classification = {}, assignments = {} } = {}) {
  const groups = groupByPerceptualHash(items);
  return groups.map((group) => {
    const canonical = pickCanonical(group);

    // Товар: сначала явное назначение сортировщика (человек сказал), затем
    // путь пула. Порядок важен — правка клиента должна бить автоматику, и
    // это касается и явного `null` («открепить от товара»): такой кадр НЕ
    // должен падать обратно на автопривязку по папке-источнику.
    let product;
    for (const member of group) {
      if (Object.prototype.hasOwnProperty.call(assignments, member.id)) {
        product = assignments[member.id];
        break;
      }
    }
    if (product === undefined) product = group.find((m) => m.product)?.product ?? null;

    // Разметка: первый член группы, о котором она есть.
    let label = null;
    for (const member of group) {
      if (classification[member.id]) {
        label = classification[member.id];
        break;
      }
    }

    return {
      ...canonical,
      product,
      // Категория из авторазметки — не то же, что категория товара: она есть
      // и у кадров, которым товар ещё не назначен, и по ней сортировщик
      // фильтрует неразобранную россыпь.
      category: label?.category ?? null,
      shot: label?.shot ?? null,
      usable: label?.usable ?? null,
      watermark: label?.watermark ?? null,
      note: label?.note ?? null,
      duplicates: group.length,
      sourcesInGroup: [...new Set(group.map((m) => m.source))].sort(),
      groupIds: group.map((m) => m.id),
    };
  });
}
