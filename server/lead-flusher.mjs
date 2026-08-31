/**
 * ============================================================================
 *  lead-flusher.mjs — авто-отправка «зависших» черновиков лидов ботам.
 * ----------------------------------------------------------------------------
 *  Правило пайплайна: если посетитель прошёл шаг 1 (телефон + согласие), но
 *  не нажал «Отправить» на шаге 2 — лид ВСЁ РАВНО уходит менеджерам через
 *  LEAD_FLUSH_MINUTES (дефолт 15). Ни один номер не теряется.
 *
 *  Живёт в ТОМ ЖЕ node-процессе, что и сайт, но подключается на старте через
 *  `node --import ./server/lead-flusher.mjs dist/server/entry.mjs`
 *  (run-команда сервиса приложения в деплой-конфиге). Почему не внутри
 *  API-роутов: роуты ленивы — после рестарта процесса зависшие черновики
 *  должны отправиться, даже если на сайт никто не заходит.
 *
 *  Zero-deps (node:fs + fetch): не зависит от бандла Astro. Контракт данных —
 *  src/lib/lead-server/leads.ts (drafts/<id>.json = { lead, due_at, attempts }).
 *
 *  Тестируется vitest'ом напрямую: экспортированный flushTick(now) — чистая
 *  функция над файловой системой, интервал в тестах не заводится.
 * ============================================================================
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.LEAD_DATA_DIR || path.resolve('data');
const DRAFTS_DIR = path.join(DATA_DIR, 'drafts');
const SENT_DIR = path.join(DRAFTS_DIR, 'sent');
const FAILED_DIR = path.join(DRAFTS_DIR, 'failed');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');
// Очередь повторной отправки конкретному боту, который заявку НЕ принял.
// Контракт с src/lib/lead-server/leads.ts: notify-retry/<slug>/<lead_id>.json
// = { url, queued_at, payload }.
const NOTIFY_RETRY_DIR = path.join(DATA_DIR, 'notify-retry');
const JSONL = path.join(DATA_DIR, 'leads.jsonl');

/**
 * Срок жизни вложений (дней). Файлы клиентов — персональные данные: лежат в
 * `attachments/<lead_id>/` и БЕЗ этой уборки копятся вечно (сам файл уже
 * доставлен в мессенджер, где и живёт дальше). Пусто/0 — уборка выключена
 * (дефолт: молча удалять данные заказчика без его решения нельзя). Текст
 * лида в `leads.jsonl` не трогается никогда — это журнал.
 */
const ATTACH_TTL_DAYS = Number(process.env.LEAD_ATTACH_TTL_DAYS || 0);
// Карантин honeypot: заявки со сработавшей ловушкой лежат столько дней, чтобы
// успеть заметить ложное срабатывание и достать номер живого человека, но не
// копиться вечно (персональные данные). 0 — не удалять.
const QUARANTINE_TTL_DAYS = Number(process.env.LEAD_QUARANTINE_TTL_DAYS || 14);

const NOTIFY_URLS = (process.env.LEAD_NOTIFY_URLS || '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
const NOTIFY_SECRET = process.env.LEAD_NOTIFY_SECRET || '';
const MAX_ATTEMPTS = 5;
const TICK_MS = 60_000;
/**
 * Сколько держать заявку в очереди к упавшему боту. Сутки — потому что после
 * них молчание уже не «сеть моргнула», а сломанный токен или выключенный
 * сервис, и повторять бессмысленно. Файл не удаляется, а помечается `.stale`:
 * это живая заявка, её разбирают руками.
 */
const NOTIFY_GIVE_UP_HOURS = Number(process.env.LEAD_NOTIFY_GIVE_UP_HOURS || 24);

function ensureDirs() {
  for (const dir of [DRAFTS_DIR, SENT_DIR, FAILED_DIR, QUARANTINE_DIR, NOTIFY_RETRY_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function journal(event, data) {
  try {
    appendFileSync(JSONL, JSON.stringify({ event, at: new Date().toISOString(), ...data }) + '\n', 'utf-8');
  } catch (err) {
    console.error('[lead-flusher] journal failed:', err);
  }
}

/** Одна отправка одному боту. Бросает — значит бот заявку НЕ принял. */
async function postToBot(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(NOTIFY_SECRET ? { 'X-Bot-Secret': NOTIFY_SECRET } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** Каталог очереди для адреса. Слаг должен совпадать с leads.ts. */
export function notifyQueueSlug(url) {
  return url.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'bot';
}

/** Отложить заявку для конкретного бота, который её не принял. */
function queueNotify(url, payload) {
  const dir = path.join(NOTIFY_RETRY_DIR, notifyQueueSlug(url));
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${payload.lead_id}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ url, queued_at: new Date().toISOString(), payload }, null, 2), 'utf-8');
    renameSync(tmp, file);
    journal('notify_queued', { lead_id: payload.lead_id, url });
  } catch (err) {
    console.error(`[lead-flusher] не удалось отложить notify для ${url}:`, err);
  }
}

/**
 * Разослать всем ботам и сказать, КТО не принял. Кто именно — важно: класть в
 * очередь можно только не принявших, иначе поднявшийся бот получит карточку
 * второй раз.
 */
async function notifyBots(payload) {
  if (NOTIFY_URLS.length === 0) return { ok: false, failedUrls: [] };
  const results = await Promise.allSettled(NOTIFY_URLS.map((url) => postToBot(url, payload)));
  return {
    ok: results.some((r) => r.status === 'fulfilled'),
    failedUrls: NOTIFY_URLS.filter((_, i) => results[i].status === 'rejected'),
  };
}

/**
 * Повтор отложенных отправок. Тот самый случай, ради которого очередь и
 * заведена: Freim Deploy на редеплое перезапускает воркеры по очереди, и
 * заявка, пришедшая в это окно, досталась только тому боту, что успел
 * подняться. Через минуту второй уже жив и получает своё.
 */
export async function retryNotifyTick(now = Date.now()) {
  if (!existsSync(NOTIFY_RETRY_DIR)) return { delivered: 0, pending: 0, stale: 0 };
  const giveUpMs = NOTIFY_GIVE_UP_HOURS * 60 * 60 * 1000;
  let delivered = 0;
  let pending = 0;
  let stale = 0;
  let slugs;
  try {
    slugs = readdirSync(NOTIFY_RETRY_DIR);
  } catch (err) {
    console.error('[lead-flusher] scan очереди повторов не удался:', err);
    return { delivered: 0, pending: 0, stale: 0 };
  }
  for (const slug of slugs) {
    const dir = path.join(NOTIFY_RETRY_DIR, slug);
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue; // не каталог — пропускаем
    }
    for (const name of files) {
      const file = path.join(dir, name);
      let record;
      try {
        record = JSON.parse(readFileSync(file, 'utf-8'));
      } catch {
        continue; // пишется прямо сейчас
      }
      if (!record?.url || !record?.payload?.lead_id) continue;
      const queuedAt = new Date(record.queued_at || 0).getTime();
      if (giveUpMs > 0 && now - queuedAt > giveUpMs) {
        try {
          renameSync(file, `${file}.stale`);
        } catch {
          /* уже убран */
        }
        journal('notify_gave_up', { lead_id: record.payload.lead_id, url: record.url });
        console.error(
          `[lead-flusher] заявка ${record.payload.lead_id} не принята ботом ${record.url} за ` +
            `${NOTIFY_GIVE_UP_HOURS} ч → ${name}.stale, разбирайте руками (лид есть в leads.jsonl)`,
        );
        stale += 1;
        continue;
      }
      try {
        await postToBot(record.url, record.payload);
        unlinkSync(file);
        journal('notify_retried', { lead_id: record.payload.lead_id, url: record.url });
        delivered += 1;
      } catch {
        pending += 1; // сосед всё ещё лежит — вернёмся через тик
      }
    }
  }
  if (delivered) {
    console.log(`[lead-flusher] доставлено из очереди повторов: ${delivered}`);
  }
  return { delivered, pending, stale };
}

/**
 * Один проход: все черновики с due_at <= now уходят ботам (stage=flushed).
 * Успех → drafts/sent/, MAX_ATTEMPTS провалов → drafts/failed/ (лид остаётся
 * в leads.jsonl — потерь нет, есть деградация до ручного разбора).
 */
export async function flushTick(now = Date.now()) {
  ensureDirs();
  let entries;
  try {
    entries = readdirSync(DRAFTS_DIR).filter((f) => f.endsWith('.json'));
  } catch (err) {
    console.error('[lead-flusher] scan failed:', err);
    return { flushed: 0, pending: 0 };
  }

  let flushed = 0;
  let pending = 0;
  for (const file of entries) {
    const full = path.join(DRAFTS_DIR, file);
    let record;
    try {
      record = JSON.parse(readFileSync(full, 'utf-8'));
    } catch {
      continue; // возможно, пишется прямо сейчас (tmp+rename защищает, но перестрахуемся)
    }
    if (!record?.lead?.lead_id || !record.due_at) continue;
    if (new Date(record.due_at).getTime() > now) {
      pending += 1;
      continue;
    }

    const payload = { ...record.lead, stage: 'flushed' };
    const { ok, failedUrls } = await notifyBots(payload).catch(() => ({
      ok: false,
      failedUrls: NOTIFY_URLS,
    }));
    if (ok) {
      // Черновик уходит в sent/ — повторять его больше некому, значит
      // не принявших откладываем в очередь.
      for (const url of failedUrls) queueNotify(url, payload);
      journal('flush', { lead_id: record.lead.lead_id });
      writeFileSync(
        path.join(SENT_DIR, file),
        JSON.stringify({ ...record.lead, flushed_at: new Date(now).toISOString() }, null, 2),
        'utf-8',
      );
      try {
        unlinkSync(full);
      } catch {
        /* уже убран */
      }
      flushed += 1;
    } else {
      record.attempts = (record.attempts ?? 0) + 1;
      if (record.attempts >= MAX_ATTEMPTS) {
        // Черновик сдаётся — дальше за заявку отвечает только очередь.
        for (const url of failedUrls) queueNotify(url, payload);
        journal('flush_failed', { lead_id: record.lead.lead_id, attempts: record.attempts });
        renameSync(full, path.join(FAILED_DIR, file));
        console.error(`[lead-flusher] лид ${record.lead.lead_id} не доставлен за ${MAX_ATTEMPTS} попыток → drafts/failed/ (сам лид сохранён в leads.jsonl)`);
      } else {
        writeFileSync(full, JSON.stringify(record, null, 2), 'utf-8');
      }
      pending += 1;
    }
  }
  return { flushed, pending };
}

/**
 * Уборка старых вложений: папка лида целиком старше LEAD_ATTACH_TTL_DAYS —
 * удаляется. Вызывается тем же тиком, что и флаш (раз в минуту): работы на
 * пустой директории — один readdir, ощутимой цены нет.
 */
export function sweepAttachments(now = Date.now()) {
  if (!(ATTACH_TTL_DAYS > 0) || !existsSync(ATTACH_DIR)) return { removed: 0 };
  const ttlMs = ATTACH_TTL_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(ATTACH_DIR);
  } catch (err) {
    console.error('[lead-flusher] scan вложений не удался:', err);
    return { removed: 0 };
  }
  for (const name of entries) {
    const dir = path.join(ATTACH_DIR, name);
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory() || now - stat.mtimeMs < ttlMs) continue;
      rmSync(dir, { recursive: true, force: true });
      journal('attachments_purged', { lead_id: name, age_days: ATTACH_TTL_DAYS });
      removed += 1;
    } catch (err) {
      console.error(`[lead-flusher] не удалось убрать вложения ${name}:`, err);
    }
  }
  if (removed) {
    console.log(`[lead-flusher] убрано папок вложений: ${removed} (старше ${ATTACH_TTL_DAYS} дн.)`);
  }
  return { removed };
}

/**
 * Уборка карантина: файл заявки, пойманной ловушкой, старше
 * LEAD_QUARANTINE_TTL_DAYS — удаляется. Смысл срока: пока запись жива, ложное
 * срабатывание можно заметить и перезвонить человеку; дальше держать чужой
 * телефон на диске незачем.
 */
export function sweepQuarantine(now = Date.now()) {
  if (!(QUARANTINE_TTL_DAYS > 0) || !existsSync(QUARANTINE_DIR)) return { removed: 0 };
  const ttlMs = QUARANTINE_TTL_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(QUARANTINE_DIR).filter((f) => f.endsWith('.json'));
  } catch (err) {
    console.error('[lead-flusher] scan карантина не удался:', err);
    return { removed: 0 };
  }
  for (const name of entries) {
    const file = path.join(QUARANTINE_DIR, name);
    try {
      if (now - statSync(file).mtimeMs < ttlMs) continue;
      unlinkSync(file);
      journal('quarantine_purged', {
        lead_id: name.replace(/\.json$/, ''),
        age_days: QUARANTINE_TTL_DAYS,
      });
      removed += 1;
    } catch (err) {
      console.error(`[lead-flusher] не удалось убрать карантин ${name}:`, err);
    }
  }
  if (removed) {
    console.log(`[lead-flusher] убрано из карантина: ${removed} (старше ${QUARANTINE_TTL_DAYS} дн.)`);
  }
  return { removed };
}

// ── Запуск интервала — только вне тестов (vitest импортирует flushTick сам) ──
if (!process.env.VITEST) {
  ensureDirs();
  console.log(
    `[lead-flusher] запущен: DATA_DIR=${DATA_DIR}, боты: ${NOTIFY_URLS.length ? NOTIFY_URLS.join(', ') : 'НЕ ЗАДАНЫ (LEAD_NOTIFY_URLS)'}`,
  );
  if (ATTACH_TTL_DAYS > 0) {
    console.log(`[lead-flusher] вложения старше ${ATTACH_TTL_DAYS} дн. удаляются автоматически`);
  }
  const timer = setInterval(() => {
    flushTick().catch((err) => console.error('[lead-flusher] tick failed:', err));
    retryNotifyTick().catch((err) => console.error('[lead-flusher] retry tick failed:', err));
    try {
      sweepAttachments();
      sweepQuarantine();
    } catch (err) {
      console.error('[lead-flusher] sweep failed:', err);
    }
  }, TICK_MS);
  timer.unref?.(); // не держим процесс, если сам сервер завершился
  // Первый проход сразу: подобрать черновики, зависшие через рестарт.
  flushTick().catch((err) => console.error('[lead-flusher] initial tick failed:', err));
  retryNotifyTick().catch((err) => console.error('[lead-flusher] initial retry failed:', err));
}
