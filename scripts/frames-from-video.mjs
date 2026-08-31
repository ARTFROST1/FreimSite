/**
 * ============================================================================
 *  frames-from-video.mjs — видео → секвенция webp-кадров под скролл-сцену.
 * ----------------------------------------------------------------------------
 *  Готовит ассеты для <ScrollScene> (docs/recipes/scroll-scenes.md): режет
 *  ролик на кадры с заданным fps и пережимает их в webp нужной ширины.
 *
 *  Две конвенции пайплайна (нарушишь — получишь либо дёрганый скраб, либо
 *  лишние минуты сборки):
 *
 *  1. 12 fps — рабочий минимум. Ниже сборка дёргается при скрабе, выше —
 *     вес растёт без видимой выгоды: глаз на прокрутке разницы не ловит.
 *  2. Кадры выходят УЖЕ финального размера и подключаются мимо astro:assets
 *     (через `asset(key).src` из реестра). Гонять сотню файлов через sharp
 *     на каждой сборке незачем — они не меняются.
 *
 *  Usage:
 *    node scripts/frames-from-video.mjs <видео> <папка-назначения>
 *    node scripts/frames-from-video.mjs a.mov src/assets/scene/seq --fps 12 \
 *         --width 1280 --quality 72
 *    node scripts/frames-from-video.mjs a.mov src/assets/scene/seq --dry
 *
 *  Требует ffmpeg и cwebp в PATH (brew install ffmpeg webp).
 * ============================================================================
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [SRC, OUT_DIR] = positional;

const FPS = Number(flag('fps', 12));
const WIDTH = Number(flag('width', 1280));
const QUALITY = Number(flag('quality', 72));
const PREFIX = flag('prefix', 'frame');

if (!SRC || !OUT_DIR) {
  console.error('Usage: node scripts/frames-from-video.mjs <video> <out-dir> [--fps 12] [--width 1280] [--quality 72] [--prefix frame] [--dry]');
  process.exit(1);
}
if (!existsSync(SRC)) {
  console.error(`Нет такого файла: ${SRC}`);
  process.exit(1);
}

function requireBin(bin, hint) {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
  } catch {
    console.error(`Не найден ${bin} в PATH. Установить: ${hint}`);
    process.exit(1);
  }
}
requireBin('ffmpeg', 'brew install ffmpeg');
requireBin('cwebp', 'brew install webp');

// Метаданные исходника — полезно видеть до нарезки: из них считается,
// сколько кадров получится и сколько это будет весить.
let meta = {};
try {
  const raw = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,r_frame_rate,duration', '-of', 'json', SRC],
    { encoding: 'utf8' },
  );
  meta = JSON.parse(raw).streams?.[0] ?? {};
} catch {
  /* ffprobe необязателен — без него просто не покажем сводку */
}

const duration = Number(meta.duration) || 0;
const expected = duration ? Math.ceil(duration * FPS) : null;

console.log(`Исходник : ${SRC}${meta.width ? ` (${meta.width}×${meta.height}` : ''}${duration ? `, ${duration.toFixed(1)} с)` : meta.width ? ')' : ''}`);
console.log(`Нарезка  : ${FPS} fps → ширина ${WIDTH}px, webp q${QUALITY}`);
if (expected) console.log(`Ожидаю   : ~${expected} кадров`);
console.log(`Назначение: ${OUT_DIR}`);

if (DRY) {
  console.log('\n--dry: ничего не записано.');
  process.exit(0);
}

if (existsSync(OUT_DIR) && readdirSync(OUT_DIR).length) {
  console.error(`\nПапка ${OUT_DIR} не пуста. Очистите её вручную — перезапись кадров вслепую слишком легко теряет чужие файлы.`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

// ffmpeg пишет PNG во временную папку, cwebp пережимает в целевую: связка
// даёт заметно меньший вес, чем webp-энкодер самого ffmpeg на тех же q.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'frames-'));
try {
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', SRC, '-vf', `fps=${FPS},scale=${WIDTH}:-2:flags=lanczos`,
      path.join(tmp, `${PREFIX}-%03d.png`)],
    { stdio: 'inherit' },
  );

  const pngs = readdirSync(tmp).filter((f) => f.endsWith('.png')).sort();
  if (!pngs.length) {
    console.error('ffmpeg не выдал ни одного кадра — проверьте исходник.');
    process.exit(1);
  }

  let bytes = 0;
  for (const png of pngs) {
    const out = path.join(OUT_DIR, png.replace(/\.png$/, '.webp'));
    execFileSync('cwebp', ['-quiet', '-q', String(QUALITY), path.join(tmp, png), '-o', out]);
    bytes += statSync(out).size;
  }

  const mb = bytes / 1024 / 1024;
  console.log(`\nГотово: ${pngs.length} кадров, ${mb.toFixed(1)} МБ (${Math.round(bytes / pngs.length / 1024)} КБ в среднем).`);
  console.log('Это цена секвенции — она грузится ТОЛЬКО при подходе к секции.');
  console.log('Подключение и бюджет загрузки: docs/recipes/scroll-scenes.md');
  if (mb > 6) {
    console.log(`\n⚠️  ${mb.toFixed(1)} МБ — многовато. Снизьте --fps или --width, либо укоротите ролик.`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
