/**
 * Тесты флашера черновиков (server/lead-flusher.mjs) — сердца правила
 * «лид с шага 1 не теряется»: черновик без complete уходит ботам через
 * LEAD_FLUSH_MINUTES, при недоступных ботах копит attempts и после 5 провалов
 * паркуется в drafts/failed (сам лид всегда остаётся в leads.jsonl).
 *
 * Флашер zero-deps и читает env на импорте, поэтому env выставляется ДО
 * динамического import(), а модуль перезагружается через vi.resetModules().
 * Сеть мокается через global.fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dataDir: string;
const DAY = 24 * 60 * 60 * 1000;

function writeDraft(id: string, dueOffsetMs: number, attempts = 0): void {
  const draftsDir = path.join(dataDir, 'drafts');
  mkdirSync(draftsDir, { recursive: true });
  writeFileSync(
    path.join(draftsDir, `${id}.json`),
    JSON.stringify({
      lead: { lead_id: id, phone: '+79001234567', source: 'calc', created_at: new Date().toISOString() },
      due_at: new Date(Date.now() + dueOffsetMs).toISOString(),
      attempts,
    }),
  );
}

async function loadFlusher() {
  vi.resetModules();
  process.env.LEAD_DATA_DIR = dataDir;
  process.env.LEAD_NOTIFY_URLS = 'http://127.0.0.1:19999/notify';
  process.env.LEAD_NOTIFY_SECRET = 'test-secret';
  // VITEST выставлен самим vitest'ом — интервал в модуле не заводится.
  return import('../../../server/lead-flusher.mjs');
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'lead-flusher-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('flushTick', () => {
  it('отправляет просроченный черновик ботам со stage=flushed и убирает его в sent/', async () => {
    writeDraft('11111111-1111-4111-8111-111111111111', -60_000);
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: init.headers as any });
      return new Response('{}', { status: 200 });
    });

    const { flushTick } = await loadFlusher();
    const result = await flushTick();

    expect(result.flushed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.stage).toBe('flushed');
    expect(calls[0].body.lead_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(calls[0].headers['X-Bot-Secret']).toBe('test-secret');
    // Черновик переехал в sent/, из активных исчез.
    expect(existsSync(path.join(dataDir, 'drafts', '11111111-1111-4111-8111-111111111111.json'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'drafts', 'sent', '11111111-1111-4111-8111-111111111111.json'))).toBe(true);
    // Событие flush записано в журнал.
    const journal = readFileSync(path.join(dataDir, 'leads.jsonl'), 'utf-8');
    expect(journal).toContain('"event":"flush"');
  });

  it('не трогает черновик, чей таймер ещё не истёк', async () => {
    writeDraft('22222222-2222-4222-8222-222222222222', 10 * 60_000);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { flushTick } = await loadFlusher();
    const result = await flushTick();

    expect(result.flushed).toBe(0);
    expect(result.pending).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('копит attempts при недоступных ботах и после 5 провалов паркует в failed/', async () => {
    writeDraft('33333333-3333-4333-8333-333333333333', -60_000, 4); // 5-я попытка станет последней
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });

    const { flushTick } = await loadFlusher();
    const result = await flushTick();

    expect(result.flushed).toBe(0);
    expect(existsSync(path.join(dataDir, 'drafts', 'failed', '33333333-3333-4333-8333-333333333333.json'))).toBe(true);
    const journal = readFileSync(path.join(dataDir, 'leads.jsonl'), 'utf-8');
    expect(journal).toContain('"event":"flush_failed"');
  });

  it('провал доставки без исчерпания попыток оставляет черновик с attempts+1', async () => {
    writeDraft('44444444-4444-4444-8444-444444444444', -60_000, 0);
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));

    const { flushTick } = await loadFlusher();
    await flushTick();

    const file = path.join(dataDir, 'drafts', '44444444-4444-4444-8444-444444444444.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8')).attempts).toBe(1);
  });

  it('пустая директория — тихий no-op', async () => {
    const { flushTick } = await loadFlusher();
    const result = await flushTick();
    expect(result).toEqual({ flushed: 0, pending: 0 });
    expect(readdirSync(path.join(dataDir, 'drafts'))).toEqual(expect.arrayContaining(['sent', 'failed']));
  });
});

/**
 * Уборка вложений (PII): папки старше LEAD_ATTACH_TTL_DAYS удаляются, свежие
 * и — главное — ВЫКЛЮЧЕННАЯ по умолчанию уборка ничего не трогают.
 */
describe('sweepAttachments', () => {
  function writeAttachment(leadId: string, ageMs: number): string {
    const dir = path.join(dataDir, 'attachments', leadId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '1.jpg'), 'x');
    const past = new Date(Date.now() - ageMs);
    utimesSync(dir, past, past);
    return dir;
  }

  it('без LEAD_ATTACH_TTL_DAYS не удаляет ничего (дефолт — хранить)', async () => {
    delete process.env.LEAD_ATTACH_TTL_DAYS;
    const { sweepAttachments } = await loadFlusher();
    const old = writeAttachment('11111111-1111-4111-8111-111111111111', 400 * DAY);

    expect(sweepAttachments().removed).toBe(0);
    expect(existsSync(old)).toBe(true);
  });

  it('с TTL удаляет только папки старше срока', async () => {
    process.env.LEAD_ATTACH_TTL_DAYS = '30';
    const { sweepAttachments } = await loadFlusher();
    const stale = writeAttachment('22222222-2222-4222-8222-222222222222', 31 * DAY);
    const fresh = writeAttachment('33333333-3333-4333-8333-333333333333', 2 * DAY);

    expect(sweepAttachments().removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    delete process.env.LEAD_ATTACH_TTL_DAYS;
  });
});
