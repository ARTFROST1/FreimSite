import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Рот-гвард переезда картинок в src/assets. Читает СОБРАННЫЙ dist/ — гоняется
 * после `npm run build` (см. docs/CMS-BUILDING.md шаг 7). Ловит два регресса:
 * (1) кто-то вернул CMS-картинку в public/ или сломал резолвер — на странице
 * снова сырой /images/cms/…; (2) <Image> потерял srcset и мобильный получает
 * оригинал.
 */
const distFile = (p: string) => resolve(process.cwd(), 'dist', p);

let home = '';
let gallery = '';

beforeAll(() => {
  const file = distFile('index.html');
  if (!existsSync(file)) throw new Error('dist/index.html не найден — прогоните `npm run build`');
  home = readFileSync(file, 'utf-8');

  // src/assets/gallery/01-demo.webp — намеренно закоммиченная тестовая
  // картинка (см. finding M8): без неё ветка "заполненная галерея" в
  // src/pages/gallery.astro никогда не исполнялась в CI, и падение сборки
  // на SVG в этой папке (finding C1) осталось бы незамеченным.
  const galleryFile = distFile('gallery/index.html');
  if (!existsSync(galleryFile)) throw new Error('dist/gallery/index.html не найден — прогоните `npm run build`');
  gallery = readFileSync(galleryFile, 'utf-8');
});

describe('showcase images', () => {
  it('рендерятся из _astro (оптимизированы), а не из public/images/cms', () => {
    expect(home).not.toContain('/images/cms/');
    const optimized = home.match(/<img[^>]+src="\/_astro\/[^"]+"/g) ?? [];
    expect(optimized.length).toBeGreaterThanOrEqual(2);
  });

  it('отдают srcset для растровых слайдов', () => {
    const withSrcset = home.match(/<img[^>]+srcset="[^"]*\/_astro\/[^"]*"/g) ?? [];
    expect(withSrcset.length).toBeGreaterThanOrEqual(2);
  });

  it('сохраняют click-to-edit разметку на самой картинке', () => {
    const imgs = home.match(/<img[^>]*data-cms="showcase:[^"]+:image"[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThanOrEqual(3);
    for (const tag of imgs) expect(tag).toContain('data-fd-attr="src"');
  });

  it('публичный путь в значении по-прежнему работает (третий слайд)', () => {
    expect(home).toContain('/images/placeholder.svg');
  });
});

describe('gallery page (src/assets/gallery/01-demo.webp)', () => {
  // Сетка — React-остров (ImageGallery.tsx), JSX-проп srcSet уходит в html
  // как атрибут `srcSet` (не `srcset`) — HTML-парсер регистронезависим, но
  // регексы ниже должны это учитывать.
  it('рендерит сетку с оптимизированным srcset из _astro', () => {
    const withSrcset = gallery.match(/<img[^>]+srcSet="[^"]*\/_astro\/[^"]*"/gi) ?? [];
    expect(withSrcset.length).toBeGreaterThanOrEqual(1);
  });

  it('задаёт sizes для srcset сетки (finding I3)', () => {
    const withSizes = gallery.match(/<img[^>]+srcSet="[^"]*"[^>]+sizes="[^"]+"/gi) ?? [];
    expect(withSizes.length).toBeGreaterThanOrEqual(1);
  });

  it('задаёт честные width/height — нет CLS-регресса (finding I2)', () => {
    const withDims = gallery.match(/<img[^>]+srcSet="[^"]*_astro[^"]*"[^>]+width="\d+"[^>]+height="\d+"/gi) ?? [];
    expect(withDims.length).toBeGreaterThanOrEqual(1);
  });
});
