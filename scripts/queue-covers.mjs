#!/usr/bin/env node
/**
 * Спека `docs/history/specs/2026-08-11-media-layers-design.md`, §Конвейер п.6.
 *
 * Готовит очередь на img2img-генерацию обложек 4:3.
 *
 * ЗАЧЕМ. Обложка — единственная картинка товара, которую видят в сетке
 * каталога, в поиске, в соцсетях и в товарном фиде. У 106 товаров из 124 она
 * сейчас взята со старого сайта, а тот пул — маркетплейсные карточки: водяные
 * знаки с логотипом бренда поверх кадра, наклеенные рекламные плашки с
 * промо-текстом, размерные стрелки. У части товаров ЧИСТОГО кадра в архиве
 * нет вовсе — сколько ни перебирай, следующий кандидат с тем же дефектом.
 * Такие товары и должны генерироваться первыми.
 *
 * ЧТО ДЕЛАЕТ
 * ----------
 * Для каждого товара кладёт в `.staging/covers-in/`:
 *   <slug>.webp        лучший исходник, уже вписанный в 4:3 (2000×1500),
 *                      фон добирается размытой копией кадра — генератору
 *                      нужен кадр целевой пропорции, а кроп резал бы изделие
 *   <slug>.txt         подсказка: что за изделие, что на исходнике, чего
 *                      требуем от результата
 * и пишет `.staging/covers-queue.json` — очередь, отсортированную по нужде.
 *
 * ПРИОРИТЕТ (поле `need`, больше — раньше)
 *   +100  весь доступный пул забракован вручную (media-overrides.json) —
 *         чистой обложки в архиве не существует
 *   +50   обложка со старого сайта (пережата до ≤1024 px)
 *   +20   у товара нет ни одного студийного кадра
 *   +10   обложка не 4:3 (в сетке каталога её кропает)
 *
 * ПОСЛЕ ГЕНЕРАЦИИ. Готовые кадры кладутся в `.staging/covers-out/<slug>.webp`
 * и забираются `import-covers.mjs`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import YAML from 'yaml';
import { withReadableImage } from './lib/readable-image.mjs';
import { REPO_ROOT, STAGING, COVER_W, COVER_H, CATEGORY_NOUN } from './media.config.mjs';

const WEBSITE_ROOT = path.resolve(import.meta.dirname, '..');
const PRODUCTS_DIR = path.join(WEBSITE_ROOT, 'src/content/products');
const ASSETS_ROOT = path.join(WEBSITE_ROOT, 'src/assets');
const IN_DIR = path.join(STAGING, 'covers-in');

const COVER_RATIO = COVER_W / COVER_H;

function readProduct(slug) {
  const raw = readFileSync(path.join(PRODUCTS_DIR, `${slug}.md`), 'utf8');
  return YAML.parse(raw.match(/^---\n([\s\S]*?)\n---/)[1]);
}

/**
 * Исходник в канон 4:3 БЕЗ КРОПА: кадр вписывается целиком, поля добираются
 * сильно размытой и растянутой копией его же. Кроп здесь недопустим — у
 * половины архива кадры вертикальные, и обрезка до 4:3 срезала бы изделию
 * спинку или ножки, то есть ровно то, что генератор должен увидеть.
 */
async function toCanvas(srcAbs, destAbs) {
  return withReadableImage(srcAbs, async (buf) => {
    const meta = await sharp(buf).rotate().metadata();
    const fitted = await sharp(buf)
      .rotate()
      .resize(COVER_W, COVER_H, { fit: 'inside', withoutEnlargement: false })
      .toBuffer();
    const fittedMeta = await sharp(fitted).metadata();

    const backdrop = await sharp(buf)
      .rotate()
      .resize(COVER_W, COVER_H, { fit: 'cover', position: 'centre' })
      .blur(40)
      .modulate({ brightness: 1.08, saturation: 0.35 })
      .toBuffer();

    await sharp(backdrop)
      .composite([
        {
          input: fitted,
          left: Math.round((COVER_W - fittedMeta.width) / 2),
          top: Math.round((COVER_H - fittedMeta.height) / 2),
        },
      ])
      .webp({ quality: 90 })
      .toFile(destAbs);

    return { width: meta.width, height: meta.height };
  });
}

function promptFor(slug, data, source, defects) {
  const noun = CATEGORY_NOUN[data.category] ?? 'изделие';
  return [
    `# Обложка каталога: ${data.title}`,
    '',
    `Товар:      ${slug} (${data.category} — ${noun})`,
    `Артикул:    ${data.article ?? '—'}`,
    `Описание:   ${data.shortDescription ?? '—'}`,
    `Исходник:   ${source.file} (${source.width}×${source.height}, пул «${source.pool}»)`,
    defects.length ? `Дефекты исходника: ${defects.join('; ')}` : 'Дефекты исходника: не отмечены',
    '',
    'ЗАДАЧА',
    `Студийная предметная съёмка: ${noun} целиком, кадр 4:3, ${COVER_W}×${COVER_H}.`,
    '',
    'ОБЯЗАТЕЛЬНО',
    '- Форма, пропорции, конструкция и цвет обивки — как на исходнике. Это',
    '  фотография реального изделия фабрики, а не новый дизайн.',
    '- Изделие целиком в кадре, ножки не срезаны, вокруг воздух.',
    '- Ровный светлый студийный фон, мягкая тень под изделием.',
    '- Ракурс три четверти, уровень камеры чуть выше сиденья.',
    '',
    'УБРАТЬ',
    '- Водяные знаки, логотипы, любой наклеенный текст и размерные стрелки.',
    '- Посторонние предметы, упаковку, поролон, обстановку цеха.',
    '- Матрас в плёнке, ярлыки, провода, подрозетники.',
    '',
    'НЕЛЬЗЯ',
    '- Менять модель: количество секций, тип ножек, характер стёжки.',
    '- Дорисовывать декор, которого нет на исходнике.',
  ].join('\n');
}

async function main() {
  const plan = existsSync(path.join(STAGING, 'media-plan.json'))
    ? JSON.parse(readFileSync(path.join(STAGING, 'media-plan.json'), 'utf8'))
    : {};
  const overrides = existsSync(path.join(STAGING, 'media-overrides.json'))
    ? JSON.parse(readFileSync(path.join(STAGING, 'media-overrides.json'), 'utf8'))
    : {};

  const defectsBySlug = {};
  for (const o of Object.values(overrides)) {
    (defectsBySlug[o.slug] ??= []).push(o.why);
  }

  mkdirSync(IN_DIR, { recursive: true });
  for (const f of readdirSync(IN_DIR)) unlinkSync(path.join(IN_DIR, f));

  const queue = [];
  for (const name of readdirSync(PRODUCTS_DIR).filter((f) => f.endsWith('.md'))) {
    const slug = name.replace(/\.md$/, '');
    const data = readProduct(slug);
    if (data.draft) continue;
    if (String(data.image).startsWith('/')) continue;

    const key = Object.keys(plan).find((k) => k.endsWith(`/${slug}`));
    const entry = key ? plan[key] : null;
    const coverFile = path.basename(data.image);
    const coverInfo = entry?.files?.[coverFile] ?? null;
    if (coverInfo?.id === undefined) continue;

    const srcAbs = path.join(REPO_ROOT, coverInfo.id);
    if (!existsSync(srcAbs)) continue;

    const destAbs = path.join(IN_DIR, `${slug}.webp`);
    const dims = await toCanvas(srcAbs, destAbs);

    const defects = defectsBySlug[slug] ?? [];
    const studioCount = Object.values(entry.files).filter((f) => f.shot === 'studio').length;
    const ratio = dims.width / dims.height;

    let need = 0;
    if (defects.length) need += 100;
    if (coverInfo.source === 'oldsite') need += 50;
    if (studioCount === 0) need += 20;
    if (Math.abs(ratio - COVER_RATIO) > 0.12) need += 10;

    writeFileSync(
      path.join(IN_DIR, `${slug}.txt`),
      promptFor(slug, data, { file: coverInfo.id, pool: coverInfo.source, ...dims }, defects),
    );
    queue.push({ slug, category: data.category, title: data.title, need, source: coverInfo.source, defects });
  }

  queue.sort((a, b) => b.need - a.need || a.slug.localeCompare(b.slug));
  writeFileSync(path.join(STAGING, 'covers-queue.json'), JSON.stringify(queue, null, 1));

  const urgent = queue.filter((q) => q.need >= 100);
  console.log(`В очереди: ${queue.length} обложек → ${path.relative(REPO_ROOT, IN_DIR)}/<slug>.webp + .txt`);
  console.log(`Срочных (чистого кадра в архиве нет): ${urgent.length}`);
  for (const q of urgent) console.log(`  ${String(q.need).padStart(3)}  ${q.slug} — ${q.defects[0]}`);
  console.log(`\nГотовые кадры класть в .staging/covers-out/<slug>.webp, затем: node scripts/import-covers.mjs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
