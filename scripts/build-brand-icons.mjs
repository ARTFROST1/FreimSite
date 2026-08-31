/**
 * Генератор всей брендовой графики из ОДНОГО мастер-SVG (порт с боевого проекта).
 *
 * Вход: `design/logo-master.svg` в корне репо (или LOGO_MASTER=путь).
 * Мастер держим вне `public/` (уехал бы на прод как есть) и вне `src/assets`
 * (попал бы в реестр картинок и предлагался бы к вставке из CMS).
 *
 * ЧТО СОБИРАЕТСЯ
 *   вектор  → public/favicon.svg              (знак на белом, для вкладки)
 *           → src/assets/brand/logo-dark.svg  (прозрачный, для светлых фонов)
 *   растр   → favicon.ico (16/32/48), favicon-96, apple-touch-icon,
 *             icons/icon-{192,512}, icons/icon-maskable-512, logo.png
 *             (logo.png нужен Organization-схеме — см. src/lib/schema.ts)
 *
 * ЗАЧЕМ СКРИПТ, а не разовая ручная нарезка: выходов тринадцать, и при
 * следующей правке знака их надо пересобрать одинаково — иначе фавиконка
 * живёт своей жизнью годами. Запуск: `npm run build:icons`.
 *
 * НАСТРОЙКА ПОД ПРОЕКТ — три константы ниже:
 *   • BRAND_TITLE — aria-label/«title» вектора (или env LOGO_TITLE);
 *   • PLATE — заливки фонового квадрата мастера (выбрасываются в прозрачной
 *     версии и белеют в plate-версии);
 *   • FILL_MAP — все остальные заливки мастера → во что их красить.
 *   Неизвестная заливка валит скрипт с ошибкой — это страховка от молчаливой
 *   потери контуров при замене мастера.
 *
 * ПАДДИНГ у растров свой у каждого и не косметический:
 *   • favicon 16–48px — впритык: на 16px поля съедают тонкие детали знака;
 *   • apple-touch     — 10%: iOS режет углы скруглением;
 *   • maskable        — 20%: safe zone спецификации (центральные 80%).
 */
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const MASTER = process.env.LOGO_MASTER || path.resolve(ROOT, 'design/logo-master.svg');

// ── Настройка под проект ──────────────────────────────────────────────
const BRAND_TITLE = process.env.LOGO_TITLE || 'BRAND';

/** Заливки фонового квадрата мастера (обе записи: rgb() и hex). */
const PLATE = ['rgb(255,255,254)', '#fffffe'];

/**
 * Остальные заливки мастера → целевой цвет. `ink: true` — контур знака,
 * который в тёмной/светлой версиях перекрашивается (остальные цвета —
 * фирменные, сохраняются как есть).
 */
const FILL_MAP = [
  { from: ['rgb(32,30,33)', '#201e21'], ink: true },
  { from: ['rgb(130,32,57)', '#822039'], to: '#822039' },
];
// ──────────────────────────────────────────────────────────────────────

/** Подложка иконок — чистый белый: в полосе вкладок и на home screen iOS
 *  любой тёплый оттенок читается как «грязный», а не как бренд. */
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

let master;
try {
  master = await readFile(MASTER, 'utf8');
} catch {
  console.error(
    `✗ Мастер-SVG не найден: ${MASTER}\n` +
      '  Положите вектор логотипа в design/logo-master.svg (корень репо)\n' +
      '  или передайте путь: LOGO_MASTER=путь npm run build:icons\n' +
      '  Затем сверьте константы PLATE / FILL_MAP с заливками вашего мастера.',
  );
  process.exit(1);
}

/**
 * Вектор пересобирается из мастера, а не правится руками: SVG из
 * трассировщика приходит с `preserveAspectRatio="none"` (знак растянулся бы
 * в любом неквадратном боксе), жёсткими width/height и служебными `data-*`.
 *
 * @param {{ plate: boolean, ink: string, title: string, viewBox: string }} opts
 */
function makeSvg({ plate, ink, title, viewBox }) {
  const paths = [...master.matchAll(/<path\b[^>]*\/>/g)].map((m) => m[0]);
  const out = [];

  for (const tag of paths) {
    const fill = /fill="([^"]+)"/.exec(tag)?.[1] ?? '';
    const d = /\bd="([^"]+)"/.exec(tag)?.[1];
    if (!d) continue;

    let color;
    if (PLATE.includes(fill.toLowerCase()) || PLATE.includes(fill)) {
      if (!plate) continue; // прозрачная версия — фоновый квадрат выбрасываем
      color = '#FFFFFF';
    } else {
      const rule = FILL_MAP.find((r) => r.from.includes(fill.toLowerCase()) || r.from.includes(fill));
      if (!rule) throw new Error(`Неизвестная заливка в мастере: ${fill} — добавьте её в PLATE или FILL_MAP`);
      color = rule.ink ? ink : rule.to;
    }
    out.push(`  <path fill="${color}" d="${d}"/>`);
  }
  // Страховка от молчаливой потери контура при следующей замене мастера:
  // прозрачные версии теряют ровно один контур — фоновый квадрат.
  const expected = paths.length - (plate ? 0 : 1);
  if (out.length !== expected) throw new Error(`Ожидалось ${expected} контуров, получено ${out.length}`);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}">`,
    `  <title>${title}</title>`,
    ...out,
    '</svg>',
    '',
  ].join('\n');
}

/**
 * viewBox трассировщика обычно шире самого знака — вокруг контуров остаётся
 * пустота, которая в кружке шапки даёт заметное кольцо, а у иконок отнимает
 * пиксели там, где их и так мало. Поэтому viewBox обрезаем по фактическим
 * чернилам: дальше «поле» задаёт только тот, кто ставит знак, — CSS или
 * `pad` ниже.
 *
 * Границу берём растеризацией, а не разбором `d`: парсер кривых Безье здесь
 * был бы отдельной библиотекой ради одного числа, а 2048px-проба даёт
 * точность до пикселя и переживёт замену мастера на любой другой контур.
 */
async function inkViewBox() {
  const box = /viewBox="([^"]+)"/.exec(master)?.[1] ?? '0 0 2048 2048';
  const probe = makeSvg({ plate: false, ink: '#000000', title: 'probe', viewBox: box });
  const { data, info } = await sharp(Buffer.from(probe), { density: 300 })
    .resize(2048, 2048, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] <= 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('Мастер отрисовался пустым — проверьте контуры');

  // Пересчёт пиксельных координат пробы обратно в единицы viewBox мастера.
  const [bx, by, bw, bh] = box.split(/\s+/).map(Number);
  const scale = Math.max(bw, bh) / 2048;
  const px = (n) => n * scale;

  // Квадратим по большей стороне и центрируем: несимметричный бокс завалил
  // бы знак набок в любом круглом контейнере.
  const side = Math.max(px(x1 - x0 + 1), px(y1 - y0 + 1));
  const cx = bx + px((x0 + x1 + 1) / 2);
  const cy = by + px((y0 + y1 + 1) / 2);
  const round = (n) => Math.round(n * 100) / 100;
  return `${round(cx - side / 2)} ${round(cy - side / 2)} ${round(side)} ${round(side)}`;
}

const VIEW_BOX = await inkViewBox();
console.log(`  viewBox по чернилам: ${VIEW_BOX}`);
const svgPlate = makeSvg({ plate: true, ink: '#201E21', title: BRAND_TITLE, viewBox: VIEW_BOX });
const svgDark = makeSvg({ plate: false, ink: '#201E21', title: BRAND_TITLE, viewBox: VIEW_BOX });

const VECTORS = [
  ['public/favicon.svg', svgPlate],
  ['src/assets/brand/logo-dark.svg', svgDark],
];
for (const [to, body] of VECTORS) {
  const dest = path.join(ROOT, to);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, body);
  console.log(`✓ ${to} (${(body.length / 1024).toFixed(1)} КБ)`);
}

/**
 * Растр рендерится из прозрачного вектора и кладётся на заливку: так поле
 * вокруг знака задаём мы, а не трассировщик, и все размеры совпадают по
 * оптическому весу.
 *
 * `density` считается от целевого размера: без width/height в SVG sharp
 * принимает единицы viewBox за пиксели при 72dpi и отрисовал бы знак в
 * исходном размере, а потом мылил его даунскейлом до 16. Берём двойной
 * запас — рендер в 2× и сжатие даёт чистое сглаживание на мелких размерах.
 */
async function raster(size, { pad = 0, bg = WHITE } = {}) {
  const inner = Math.round(size * (1 - pad * 2));
  const side = Number(VIEW_BOX.split(' ')[2]);
  const density = Math.min(2400, Math.max(1, (72 * inner * 2) / side));
  const mark = await sharp(Buffer.from(svgDark), { density })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: bg },
  })
    .composite([{ input: mark, gravity: 'center' }])
    .flatten({ background: bg });
}

const PNGS = [
  // Логотип организации для Schema.org/шеринга: только растр с фоном —
  // под альфу парсеры подкладывают что угодно.
  { to: 'public/logo.png', size: 512, pad: 0.06 },
  { to: 'public/favicon-96.png', size: 96, pad: 0.02 },
  { to: 'public/apple-touch-icon.png', size: 180, pad: 0.1 },
  { to: 'public/icons/icon-192.png', size: 192, pad: 0.06 },
  { to: 'public/icons/icon-512.png', size: 512, pad: 0.06 },
  { to: 'public/icons/icon-maskable-512.png', size: 512, pad: 0.2 },
];
for (const { to, size, pad } of PNGS) {
  const dest = path.join(ROOT, to);
  await mkdir(path.dirname(dest), { recursive: true });
  await (await raster(size, { pad })).png({ compressionLevel: 9 }).toFile(dest);
  console.log(`✓ ${to} (${size}×${size})`);
}

/**
 * .ico — контейнер ICONDIR (6 байт) + по 16 байт на запись + сами картинки.
 * Пишем PNG-полезную нагрузку вместо BMP: так умеют все браузеры начиная с
 * IE11, а BMP-ветка потребовала бы ручной AND-маски. Внешней зависимости
 * (png-to-ico) нет намеренно — формат тут в двадцать строк.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // ширина (0 == 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // высота
    e.writeUInt8(0, 2); // палитра не используется
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // бит на пиксель
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// 16/32/48 в одном файле: браузеры и Яндекс.Вебмастер до сих пор дёргают
// `/favicon.ico` напрямую, минуя <link>.
const icoSizes = [16, 32, 48];
const icoImages = await Promise.all(
  icoSizes.map(async (size) => ({
    size,
    data: await (await raster(size)).png({ compressionLevel: 9 }).toBuffer(),
  })),
);
await writeFile(path.join(ROOT, 'public/favicon.ico'), buildIco(icoImages));
console.log(`✓ public/favicon.ico (${icoSizes.join('/')})`);
