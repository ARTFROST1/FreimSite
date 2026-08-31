/**
 * Smoke-тест статической сборки: `node scripts/smoke.mjs` после `astro build`.
 *
 * Не поднимает сервер — сайт статический, достаточно прочитать `dist/`.
 * Проверяет у каждого ключевого маршрута: файл есть, в нём `<title>`,
 * `lang="ru"`, canonical, и НЕТ литерала `{\`` в теле `<script>` —
 * признак обёрнутого в `{`…`}` inline-скрипта (AGENTS.md, «Запреты»:
 * так неделями молчала Метрика). Плюс — служебные роуты из ROUTES_NOINDEX
 * обязаны нести `noindex`.
 *
 * Выход 1 при любом провале. Список маршрутов — минимальный «скелет»
 * стартера; при переделке под проект правьте ROUTES.
 */
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');

const ROUTES = ['/', '/about/', '/contacts/', '/gallery/', '/blog/', '/katalog/'];
// Юрдоки: noindex зависит от LEGAL.placeholder (src/config/legal.ts) — проверяем только сборку.
const ROUTES_LEGAL = ['/privacy-policy/', '/soglasie-na-obrabotku-dannykh/', '/terms/'];
const ROUTES_NOINDEX = ['/thanks/', '/ui-kit/', '/sortirovka/'];
const FILES = ['/sitemap-index.xml', '/robots.txt', '/rss.xml'];

const failures = [];
const fail = (route, msg) => failures.push(`${route}: ${msg}`);

async function readRoute(route) {
  const path = resolve(DIST, `.${route}index.html`);
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function checkHtml(route, html, { noindex }) {
  if (!/<title>[^<]+<\/title>/.test(html)) fail(route, 'нет <title>');
  if (!/<html[^>]*\blang="ru"/.test(html)) fail(route, 'нет lang="ru"');
  if (/<script[^>]*>\s*\{`/.test(html)) fail(route, 'inline-скрипт обёрнут в {`…`} — мёртвая строка');
  if (noindex === undefined) return; // юрдоки: индексация — по флагу legal.ts
  const hasNoindex = /<meta name="robots" content="[^"]*noindex/.test(html);
  if (noindex && !hasNoindex) fail(route, 'служебная страница без noindex');
  if (!noindex) {
    if (hasNoindex) fail(route, 'публичная страница с noindex');
    if (!/<link rel="canonical"/.test(html)) fail(route, 'нет canonical');
  }
}

for (const route of ROUTES) {
  const html = await readRoute(route);
  if (html === null) {
    fail(route, 'файл не собран');
    continue;
  }
  checkHtml(route, html, { noindex: false });
}

for (const route of ROUTES_LEGAL) {
  const html = await readRoute(route);
  if (html === null) {
    fail(route, 'файл не собран');
    continue;
  }
  checkHtml(route, html, { noindex: undefined });
}

for (const route of ROUTES_NOINDEX) {
  const html = await readRoute(route);
  if (html === null) continue; // служебные роуты могут отсутствовать на проекте
  checkHtml(route, html, { noindex: true });
}

for (const file of FILES) {
  try {
    await access(resolve(DIST, `.${file}`));
  } catch {
    fail(file, 'файл не собран');
  }
}

if (failures.length) {
  console.error(`smoke: ${failures.length} провал(ов)\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log(`smoke: ok — ${ROUTES.length + ROUTES_LEGAL.length} маршрутов, ${FILES.length} файлов, noindex проверен`);
