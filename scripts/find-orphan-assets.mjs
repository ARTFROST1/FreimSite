/**
 * Отчёт: файлы в src/assets/cms/, на которые не ссылается ни один JSON в
 * src/content/. Клиент заменил фото → старое остаётся в репозитории навсегда:
 * astro:assets его не тронет (не используется), но вес репозитория и время
 * `npm ci` растут. Скрипт НИЧЕГО НЕ УДАЛЯЕТ — только печатает список, потому
 * что на картинку может ссылаться контент, которого ещё нет в этой ветке.
 *
 * Запуск: npm run assets:orphans
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const CMS_DIR = 'src/assets/cms';
const CONTENT_DIR = 'src/content';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let files = [];
try {
  files = walk(CMS_DIR);
} catch {
  console.log(`${CMS_DIR} пуста или отсутствует — сирот нет.`);
  process.exit(0);
}

const haystack = walk(CONTENT_DIR)
  .filter((p) => /\.(json|mdx?|ya?ml)$/i.test(p))
  .map((p) => readFileSync(p, 'utf-8'))
  .join('\n');

const orphans = files.filter((p) => !haystack.includes(relative(CMS_DIR, p)));

if (orphans.length === 0) {
  console.log(`Все ${files.length} файлов в ${CMS_DIR} используются.`);
  process.exit(0);
}

let bytes = 0;
for (const p of orphans) bytes += statSync(p).size;
console.log(`Не используются (${orphans.length} файлов, ${(bytes / 1024 / 1024).toFixed(1)} МБ):`);
for (const p of orphans) console.log(`  ${p}`);
console.log('\nУдалять вручную и только убедившись, что ветка содержит актуальный контент.');
