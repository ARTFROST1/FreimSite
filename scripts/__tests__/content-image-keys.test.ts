import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Каждый ключ реестра, на который ссылается контент, обязан существовать в
 * `src/assets/`.
 *
 * ЗАЧЕМ. Резолвер сознательно не роняет сборку на битой ссылке — контент
 * пишет клиент через портал, и опечатка не должна класть сайт (см.
 * `src/lib/images/resolve.ts`: печатает варнинг и подставляет плейсхолдер).
 * Плата за это — битая ссылка молча доезжает до продакшена серым квадратом,
 * а варнинг тонет в двух тысячах строк лога сборки.
 *
 * Этот тест — вторая половина той сделки: сборка по-прежнему не падает, но
 * прогон тестов падает. Написан после переезда на слои image/slider/gallery
 * (спека 2026-08-11): переименование файлов `NN.webp` → `st-NN.webp` оставило
 * 18 висячих ссылок в `reviews.json`, `categories.json` и `SituationsSection`,
 * и поймал их не тест, а глаз в логе.
 *
 * Читает ИСХОДНИКИ, не `dist/` — работает без предварительной сборки.
 */

const ROOT = path.resolve(process.cwd());
const ASSETS = path.join(ROOT, 'src/assets');

/** Значение поля-картинки: ключ реестра, публичный путь или внешний URL. */
const IMAGE_VALUE = /["']((?:[a-z0-9][a-z0-9._-]*\/)+[a-zA-Z0-9._-]+\.(?:webp|avif|jpe?g|png|svg))["']/g;

/** Файлы, где вообще могут встречаться ключи реестра. */
function contentFiles(): string[] {
  const roots = ['src/content', 'src/components', 'src/config', 'src/pages', 'src/layouts'];
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(json|md|astro|ts)$/.test(name)) out.push(full);
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  return out;
}

describe('ключи картинок в контенте', () => {
  it('каждый ключ реестра указывает на существующий файл в src/assets', () => {
    const broken: string[] = [];

    for (const file of contentFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(IMAGE_VALUE)) {
        const value = match[1];
        // Публичные пути (`/images/…`) и внешние URL реестром не резолвятся:
        // их отдают как есть, файл лежит в public/ или на чужом домене.
        if (value.startsWith('/') || value.includes('://')) continue;
        // Импорты модулей и относительные пути внутри кода — не ключи реестра.
        if (value.startsWith('.') || value.startsWith('src/') || value.startsWith('node_modules')) continue;
        // `assets/img/…` — пространство имён рантайм-загрузчика ассетов
        // (атрибут `data-asset`, см. DeliverySection.astro), а не реестра:
        // тот же файл лежит в реестре под ключом без префикса.
        if (value.startsWith('assets/')) continue;
        if (!existsSync(path.join(ASSETS, value))) {
          broken.push(`${path.relative(ROOT, file)} → ${value}`);
        }
      }
    }

    expect(broken, `битые ключи реестра:\n  ${broken.join('\n  ')}`).toEqual([]);
  });

  it('у каждого товара обложка и слои ссылаются на его собственную папку', () => {
    const dir = path.join(ROOT, 'src/content/products');
    const wrong: string[] = [];

    for (const name of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const slug = name.replace(/\.md$/, '');
      const fm = readFileSync(path.join(dir, name), 'utf8').split('---')[1] ?? '';
      const category = fm.match(/^category:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
      if (!category) continue;
      const own = `products/${category}/${slug}/`;

      for (const match of fm.matchAll(/"(products\/[^"]+)"/g)) {
        if (!match[1].startsWith(own)) wrong.push(`${slug}: ${match[1]}`);
      }
    }

    expect(wrong, `кадры из чужой папки:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });
});

/**
 * Опубликованный товар обязан иметь настоящую обложку.
 *
 * ЗАЧЕМ. Схема требует непустой `image`, поэтому товару без единого кадра
 * можно поставить `/images/placeholder.svg` — валидное значение, сборка
 * проходит, страница живёт и уезжает в sitemap с серым квадратом вместо
 * товара. Здесь та же сделка, что и в тестах выше: плейсхолдер по-прежнему
 * разрешён (он держит схему валидной, пока не готовы настоящие фото), но
 * только у черновика (`draft: true`) — опубликованный товар без фото не
 * должен молча уехать на витрину.
 *
 * Портировано с боевого проекта: там ту же дыру поймал не тест, а человек — товар
 * полгода провисел на витрине с плейсхолдером после того, как прогон
 * медиа-конвейера забрал у него единственный кадр уже ПОСЛЕ импорта в
 * черновики (правило «остался без кадров → draft: true» сработало только на
 * самом импорте).
 */
describe('обложки опубликованных товаров', () => {
  it('ни один не-черновик не показывает плейсхолдер вместо фото', () => {
    const dir = path.join(ROOT, 'src/content/products');
    const naked: string[] = [];

    for (const name of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const fm = readFileSync(path.join(dir, name), 'utf8').split('---')[1] ?? '';
      const isDraft = /^draft:\s*true\s*$/m.test(fm);
      // Значение `image:` в контенте стартера — незакавыченный YAML-скаляр
      // (`image: /images/placeholder.svg`), а не строка в кавычках, как было
      // на боевом проекте — кавычки здесь опциональны (тот же приём, что скан `category`
      // в astro.config.mjs).
      const image = fm.match(/^image:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1] ?? '';
      if (!isDraft && image.includes('placeholder')) {
        naked.push(`${name.replace(/\.md$/, '')} → ${image}`);
      }
    }

    expect(
      naked,
      `опубликованы без фото (нужен кадр или draft: true):\n  ${naked.join('\n  ')}`,
    ).toEqual([]);
  });
});
