/**
 * Буфер картинки, который умеет прочитать sharp.
 *
 * ЗАЧЕМ. Больше половины архива клиента — HEIC с айфона, а sharp в этой сборке
 * собран без libheif и падает на нём с «Support for this compression format has
 * not been built in». Обходной путь один и тот же во всех скриптах конвейера:
 * прогнать файл через системный `sips` во временный jpeg. Раньше эта функция
 * жила копиями в `prepare-photos.mjs`, `build-media-index.mjs`,
 * `build-media-collages.mjs` и `apply-media.mjs` — и `queue-covers.mjs`
 * упал ровно потому, что копию туда забыли положить.
 *
 * Вызывающий обязан удалить `tmp`, если он не null.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function readableImage(absPath) {
  if (path.extname(absPath).toLowerCase() !== '.heic') {
    return { buf: readFileSync(absPath), tmp: null };
  }
  const tmp = path.join(os.tmpdir(), `ri-${crypto.randomBytes(8).toString('hex')}.jpg`);
  execFileSync('sips', ['-s', 'format', 'jpeg', absPath, '--out', tmp], { stdio: 'ignore' });
  return { buf: readFileSync(tmp), tmp };
}

/** `readableImage` + гарантированная уборка временного файла. */
export async function withReadableImage(absPath, fn) {
  const { buf, tmp } = readableImage(absPath);
  try {
    return await fn(buf);
  } finally {
    if (tmp && existsSync(tmp)) unlinkSync(tmp);
  }
}
