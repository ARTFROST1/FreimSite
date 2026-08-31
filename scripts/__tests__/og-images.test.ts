/**
 * OG-кадры каталога и блога: заявленное в мете обязано совпадать с файлом.
 *
 * ЗАЧЕМ. `og:image:width`/`height` — подсказка парсеру: по ней соцсеть решает,
 * рисовать крупную карточку или мелкую иконку, ещё до того как скачает файл.
 * Если числа расходятся с реальными, превью гаснет или уезжает в мелкий
 * формат, причём молча — ни сборка, ни typecheck об этом не скажут. Так уже
 * случалось на боевом проекте: `resolveOgImage` (здесь — `src/lib/og-image.ts`)
 * просил у Astro фиксированный кадр и эти же числа писал в мету, но сервис
 * картинок не увеличивает изображение — на большинстве карточек мета обещала
 * размер, которого в файле не было. Поймал это человек, открыв ссылку в
 * мессенджере, а не тест.
 *
 * ГЛУБИНА ОБХОДА. У стартера, в отличие от плоского боевого каталога, дерево
 * категорий может быть и плоским (`/katalog/dveri/<товар>/`), и с одной
 * подкатегорией (`/katalog/okna/okna-plastikovye/<товар>/`) — фиксированной
 * глубины нет. Поэтому обход ищет `index.html` НА ЛЮБОЙ глубине под `katalog/`
 * и `blog/`, а не считает уровни вложенности.
 *
 * ФОЛБЭК. Категории и демо-статьи блога не обязаны иметь свою фотографию —
 * `resolveOgImage` тогда отдаёт статическую обложку `SITE.ogImage`
 * (`public/og/og-default.jpg` — нейтральный плейсхолдер без текста и
 * брендинга, см. `public/og/README.md`: заменить своим перед запуском).
 * Строгие поэтажные проверки размера/формата ниже применяются только к
 * кадрам, которые реально сгенерировал Astro (`/_astro/...` — оптимизированный
 * ассет с хешем в имени) — а сам файл статического фолбэка проверяется
 * отдельным, безусловным стражем: он обязан существовать в `dist/` и его
 * реальные размеры обязаны совпадать с `OG_FALLBACK.width/height`, иначе
 * страницы без фото молча отдают 404 вместо превью.
 *
 * Читает `dist/` — запускать после `npm run build` (так же устроен
 * annotations.test.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { SITE } from '../../src/config/site';
import { OG_FALLBACK } from '../../src/lib/og-image';

const ROOT = path.resolve(process.cwd());
const DIST = path.join(ROOT, 'dist');

/** Минимум, ниже которого соцсеть рисует иконку вместо крупной карточки. */
const MIN_WIDTH = 600;
const MIN_HEIGHT = 315;
/** Потолок кадра: больше исходника Astro не отдаст, меньше — по каждой оси. */
const MAX_WIDTH = 1200;
const MAX_HEIGHT = 630;

/**
 * Все страницы `index.html` под `dir`, на любой глубине. Обходим дерево сами
 * через `readdirSync`, БЕЗ вызова `find`/шелла — так тест одинаково работает
 * на Linux, macOS и Windows (см. content-image-keys.test.ts — тот же приём).
 */
function htmlPages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlPages(full));
    else if (entry.name === 'index.html') found.push(full);
  }
  return found;
}

interface Card {
  page: string;
  url: string;
  declaredW: number;
  declaredH: number;
  file: string;
  /** Сгенерированный Astro ассет (хеш в имени), а не статический фолбэк
   *  из `public/`. Только эти кадры честно проверяемы: см. doc-comment файла. */
  generated: boolean;
}

function readCards(): Card[] {
  const pages = [
    ...htmlPages(path.join(DIST, 'katalog')),
    ...htmlPages(path.join(DIST, 'blog')),
  ];
  return pages.map((page) => {
    const html = readFileSync(page, 'utf8');
    const url = /og:image" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const pathname = url.startsWith(SITE.url) ? url.slice(SITE.url.length) : url;
    return {
      page: path.relative(DIST, page),
      url,
      declaredW: Number(/og:image:width" content="(\d+)"/.exec(html)?.[1] ?? 0),
      declaredH: Number(/og:image:height" content="(\d+)"/.exec(html)?.[1] ?? 0),
      file: path.join(DIST, pathname),
      generated: pathname.startsWith('/_astro/'),
    };
  });
}

describe('OG-кадры каталога и блога (нужен npm run build)', () => {
  const cards = readCards();
  const generated = cards.filter((c) => c.generated);
  /** Метаданные читаются один раз и параллельно: последовательным sharp'ом
   *  по всем карточкам легко не уложиться в дефолтный таймаут vitest. */
  const meta = new Map<string, { width?: number; height?: number; format?: string }>();

  beforeAll(async () => {
    await Promise.all(
      generated
        .filter((c) => existsSync(c.file))
        .map(async (c) => void meta.set(c.file, await sharp(c.file).metadata())),
    );
  });

  it('сборка вообще есть и страницы каталога/блога найдены', () => {
    expect(cards.length, 'нет dist/katalog или dist/blog — запусти npm run build').toBeGreaterThan(0);
  });

  it('хотя бы один honest-резолв сгенерировал OG-кадр (демо-товар с реальной обложкой)', () => {
    expect(
      generated.length,
      'ни одна карточка не сгенерировала /_astro/-кадр — проверьте demo-товары и src/lib/og-image.ts',
    ).toBeGreaterThan(0);
  });

  it('у каждого сгенерированного OG-кадра файл реально лежит в сборке', () => {
    const missing = generated.filter((c) => !existsSync(c.file)).map((c) => `${c.page} → ${c.url}`);
    expect(missing, `битые OG-картинки:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('заявленные og:image:width/height совпадают с реальными размерами файла', () => {
    const lying = generated
      .filter((c) => meta.has(c.file))
      .filter((c) => meta.get(c.file)!.width !== c.declaredW || meta.get(c.file)!.height !== c.declaredH)
      .map((c) => {
        const m = meta.get(c.file)!;
        return `${c.page}: мета ${c.declaredW}×${c.declaredH}, файл ${m.width}×${m.height}`;
      });
    expect(lying, `мета врёт о размере OG-кадра:\n  ${lying.join('\n  ')}`).toEqual([]);
  });

  it('кадр не мельче минимума для крупной карточки', () => {
    const tiny = generated
      .filter((c) => c.declaredW < MIN_WIDTH || c.declaredH < MIN_HEIGHT)
      .map((c) => `${c.page}: ${c.declaredW}×${c.declaredH}`);
    expect(tiny, `мельче ${MIN_WIDTH}×${MIN_HEIGHT} — соцсеть покажет иконкой:\n  ${tiny.join('\n  ')}`).toEqual([]);
  });

  it('кадр не крупнее 1200×630 — апскейла быть не должно', () => {
    // Пропорция 1.91:1 намеренно не проверяется: на вертикальных обложках
    // ради неё пришлось бы обрезать половину товара/иллюстрации, а крупную
    // карточку соцсети рисуют для любого кадра от 600×315. Здесь важно
    // другое — что кадр не растянут за пределы исходника.
    const oversized = generated
      .filter((c) => c.declaredW > MAX_WIDTH || c.declaredH > MAX_HEIGHT)
      .map((c) => `${c.page}: ${c.declaredW}×${c.declaredH}`);
    expect(oversized, `крупнее ${MAX_WIDTH}×${MAX_HEIGHT}:\n  ${oversized.join('\n  ')}`).toEqual([]);
  });

  it('OG-кадр отдаётся в JPEG — самый совместимый формат для парсеров', () => {
    const wrong = generated
      .filter((c) => meta.has(c.file) && meta.get(c.file)!.format !== 'jpeg')
      .map((c) => `${c.page}: ${meta.get(c.file)!.format}`);
    expect(wrong, `не JPEG:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  /**
   * Страж статического фолбэка (безусловный — раз он вообще заявлен как
   * дефолт в `src/lib/og-image.ts`, он обязан реально лежать в `dist/`, а не
   * 404-ить у категорий/постов без своей фотографии). Не через `generated`
   * выше: этот файл копируется из `public/` как есть, без хеша Astro в имени.
   */
  it('статический OG-фолбэк существует в dist/ и совпадает по размеру с OG_FALLBACK', async () => {
    const file = path.join(DIST, OG_FALLBACK.src);
    expect(existsSync(file), `нет ${OG_FALLBACK.src} в dist/ — og:image фолбэк 404-ит`).toBe(true);
    const fallbackMeta = await sharp(file).metadata();
    expect(
      [fallbackMeta.width, fallbackMeta.height],
      `${OG_FALLBACK.src}: заявлено ${OG_FALLBACK.width}×${OG_FALLBACK.height}, реально ${fallbackMeta.width}×${fallbackMeta.height}`,
    ).toEqual([OG_FALLBACK.width, OG_FALLBACK.height]);
  });
});
