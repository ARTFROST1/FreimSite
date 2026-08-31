/**
 * IndexNow ping — runs automatically after `astro build` (postbuild).
 * Reads the generated sitemap, extracts URLs, and notifies Yandex + Bing so
 * they recrawl changed pages fast.
 *
 * No-ops (exit 0) when INDEXNOW_KEY is unset, so it never breaks the build.
 * Enable it: generate a random key, save it as public/<key>.txt, and set
 * INDEXNOW_KEY in .env.
 *
 * PUBLIC_INDEXNOW_KEY — фолбэк для панелей деплоя, которые прокидывают в
 * сборку сервиса только переменные с префиксом PUBLIC_*. Ключ и так публичен
 * по протоколу IndexNow (лежит открытым файлом на /<key>.txt), так что
 * префикс ничего не палит. INDEXNOW_KEY в приоритете, если заданы оба.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.INDEXNOW_KEY || process.env.PUBLIC_INDEXNOW_KEY;
const DIST = 'dist';

if (!KEY) {
  console.log('[indexnow] INDEXNOW_KEY not set — skipping.');
  process.exit(0);
}

function findSitemaps() {
  if (!existsSync(DIST)) return [];
  return readdirSync(DIST).filter((f) => f.startsWith('sitemap') && f.endsWith('.xml'));
}

function extractUrls() {
  const urls = new Set();
  for (const file of findSitemaps()) {
    const xml = readFileSync(join(DIST, file), 'utf-8');
    for (const m of xml.matchAll(/<loc>(.*?)<\/loc>/g)) {
      if (!m[1].endsWith('.xml')) urls.add(m[1]);
    }
  }
  return [...urls];
}

async function ping(host, urlList, siteHost) {
  const body = {
    host: siteHost,
    key: KEY,
    keyLocation: `https://${siteHost}/${KEY}.txt`,
    urlList,
  };
  try {
    const res = await fetch(`https://${host}/indexnow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    console.log(`[indexnow] ${host} → ${res.status}`);
  } catch (e) {
    console.log(`[indexnow] ${host} failed: ${e.message}`);
  }
}

const urls = extractUrls();
if (urls.length === 0) {
  console.log('[indexnow] no URLs found in sitemap — skipping.');
  process.exit(0);
}

const siteHost = new URL(urls[0]).host;
console.log(`[indexnow] submitting ${urls.length} URLs for ${siteHost}`);
await ping('yandex.com', urls, siteHost);
await ping('www.bing.com', urls, siteHost);
