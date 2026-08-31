/**
 * Очередь повторной отправки ботам (notify-retry).
 *
 * Закрывает конкретный боевой случай 22.08.2026: заявка ушла в MAX и НЕ ушла
 * в Telegram. Собственная очередь бота тут не спасает — она хранит уже
 * принятое, а лежащий бот заявку вообще не видел. Окно, в котором бот лежит,
 * не экзотика: Freim Deploy на каждом редеплое перезапускает воркеры по
 * очереди.
 *
 * Главное, что здесь проверяется, — что здоровый бот НЕ получает карточку
 * дважды: повторяем адресно, только не принявшим.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TG = 'http://127.0.0.1:8091/notify';
const MAX = 'http://127.0.0.1:8092/notify';

let dataDir: string;

async function loadFlusher() {
  vi.resetModules();
  process.env.LEAD_DATA_DIR = dataDir;
  process.env.LEAD_NOTIFY_URLS = `${TG},${MAX}`;
  process.env.LEAD_NOTIFY_SECRET = 'test-secret';
  return import('../../../server/lead-flusher.mjs');
}

/** Сеть, где один из ботов лежит: его адрес бросает connection refused. */
function stubNetwork(downUrls: string[], seen: string[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      seen.push(url);
      if (downUrls.some((d) => url.startsWith(d))) {
        throw new Error('connect ECONNREFUSED');
      }
      return { ok: true, status: 200 } as Response;
    }),
  );
  return seen;
}

function writeDraft(id: string, dueOffsetMs: number): void {
  const draftsDir = path.join(dataDir, 'drafts');
  mkdirSync(draftsDir, { recursive: true });
  writeFileSync(
    path.join(draftsDir, `${id}.json`),
    JSON.stringify({
      lead: { lead_id: id, phone: '+79001234567', source: 'popup' },
      due_at: new Date(Date.now() + dueOffsetMs).toISOString(),
      attempts: 0,
    }),
  );
}

function queueFiles(): string[] {
  const root = path.join(dataDir, 'notify-retry');
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((slug) => {
    const dir = path.join(root, slug);
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => `${slug}/${f}`);
    } catch {
      return [];
    }
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'notify-retry-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('очередь повторной отправки', () => {
  it('кладёт в очередь только упавшего бота, когда второй заявку принял', async () => {
    const seen = stubNetwork([TG]);
    const { flushTick } = await loadFlusher();
    writeDraft('lead-1', -1000);

    const res = await flushTick(Date.now());

    expect(res.flushed).toBe(1); // MAX принял — черновик закрыт
    const queued = queueFiles();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toContain('lead-1.json');
    const record = JSON.parse(
      readFileSync(path.join(dataDir, 'notify-retry', queued[0]), 'utf-8'),
    );
    expect(record.url).toBe(TG); // именно упавший, а не оба
    expect(record.payload.lead_id).toBe('lead-1');
    expect(seen.filter((u) => u === MAX)).toHaveLength(1);
  });

  it('досылает заявку, когда бот поднялся, и НЕ трогает того, кто её уже получил', async () => {
    stubNetwork([TG]);
    const flusher = await loadFlusher();
    writeDraft('lead-2', -1000);
    await flusher.flushTick(Date.now());
    expect(queueFiles()).toHaveLength(1);

    // Бот поднялся (редеплой закончился).
    const seen: string[] = [];
    stubNetwork([], seen);
    const res = await flusher.retryNotifyTick(Date.now());

    expect(res.delivered).toBe(1);
    expect(queueFiles()).toHaveLength(0);
    expect(seen).toEqual([TG]); // MAX не дёрнут — иначе была бы вторая карточка
  });

  it('оставляет заявку в очереди, пока бот всё ещё лежит', async () => {
    stubNetwork([TG]);
    const flusher = await loadFlusher();
    writeDraft('lead-3', -1000);
    await flusher.flushTick(Date.now());

    const res = await flusher.retryNotifyTick(Date.now());

    expect(res.delivered).toBe(0);
    expect(res.pending).toBe(1);
    expect(queueFiles()).toHaveLength(1);
  });

  it('через сутки помечает заявку .stale, но НЕ удаляет — это живой человек', async () => {
    stubNetwork([TG]);
    const flusher = await loadFlusher();
    writeDraft('lead-4', -1000);
    const now = Date.now();
    await flusher.flushTick(now);

    const res = await flusher.retryNotifyTick(now + 25 * 60 * 60 * 1000);

    expect(res.stale).toBe(1);
    expect(queueFiles()).toHaveLength(0); // .json больше нет
    const slug = readdirSync(path.join(dataDir, 'notify-retry'))[0];
    const left = readdirSync(path.join(dataDir, 'notify-retry', slug));
    expect(left).toEqual(['lead-4.json.stale']);
  });

  it('когда лежат ОБА бота, черновик повторяет сам и очередь не заводит', async () => {
    stubNetwork([TG, MAX]);
    const flusher = await loadFlusher();
    writeDraft('lead-5', -1000);

    const res = await flusher.flushTick(Date.now());

    expect(res.flushed).toBe(0);
    // Иначе заявку повторяли бы двое сразу — и карточка задвоилась бы.
    expect(queueFiles()).toHaveLength(0);
    const draft = JSON.parse(
      readFileSync(path.join(dataDir, 'drafts', 'lead-5.json'), 'utf-8'),
    );
    expect(draft.attempts).toBe(1);
  });

  it('слаг адреса совпадает с тем, что пишет сайт (leads.ts)', async () => {
    const { notifyQueueSlug } = await loadFlusher();
    expect(notifyQueueSlug(TG)).toBe('http-127-0-0-1-8091-notify');
    expect(notifyQueueSlug(MAX)).toBe('http-127-0-0-1-8092-notify');
  });
});
