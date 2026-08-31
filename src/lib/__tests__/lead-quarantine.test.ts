/**
 * Ловушка для ботов: заявка со сработавшим honeypot НЕ идёт менеджерам,
 * но и не пропадает — ложится в карантин и удаляется оттуда по TTL.
 *
 * Главный инвариант этих тестов: заявку нельзя потерять молча. 21.08.2026
 * автозаполнение браузера заполнило скрытое поле у живого человека, сервер
 * ответил «принято» и удалил заявку — узнали об этом только из логов Caddy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'lead-quarantine-'));
  process.env.LEAD_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.LEAD_DATA_DIR;
  delete process.env.LEAD_QUARANTINE_TTL_DAYS;
});

describe('карантин honeypot', () => {
  it('сохраняет заявку на диск и пишет её в журнал', async () => {
    const { quarantineLead } = await import('../lead-server/leads');

    quarantineLead(
      { lead_id: 'abc-123', phone: '+79001234567', consent: true, name: 'Бот' } as never,
      'complete',
    );

    const file = path.join(dataDir, 'quarantine', 'abc-123.json');
    expect(existsSync(file)).toBe(true);

    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved.phone).toBe('+79001234567');
    expect(saved.reason).toBe('honeypot');
    expect(saved.stage).toBe('complete');
    expect(saved.quarantined_at).toBeTruthy();

    // Событие видно в общем журнале — иначе потерю снова никто не заметит.
    const journal = readFileSync(path.join(dataDir, 'leads.jsonl'), 'utf-8');
    expect(journal).toContain('"event":"quarantined"');
    expect(journal).toContain('abc-123');
  });

  it('не создаёт черновик: флашер не должен разослать такую заявку ботам', async () => {
    const { quarantineLead } = await import('../lead-server/leads');
    quarantineLead({ lead_id: 'bot-1', phone: '+79001234567', consent: true } as never, 'draft');

    const draftsDir = path.join(dataDir, 'drafts');
    const drafts = existsSync(draftsDir)
      ? readdirSync(draftsDir).filter((f) => f.endsWith('.json'))
      : [];
    expect(drafts).toHaveLength(0);
  });

  it('считает карантин для /api/health', async () => {
    const { quarantineLead, quarantineStats } = await import('../lead-server/leads');
    quarantineLead({ lead_id: 'a', phone: '+79001111111', consent: true } as never, 'draft');
    quarantineLead({ lead_id: 'b', phone: '+79002222222', consent: true } as never, 'draft');

    const stats = quarantineStats();
    expect(stats.total).toBe(2);
    expect(stats.last24h).toBe(2);
  });
});

describe('очистка карантина по TTL', () => {
  it('удаляет записи старше срока и не трогает свежие', async () => {
    process.env.LEAD_QUARANTINE_TTL_DAYS = '14';
    const { quarantineLead } = await import('../lead-server/leads');
    quarantineLead({ lead_id: 'old', phone: '+79001111111', consent: true } as never, 'draft');
    quarantineLead({ lead_id: 'fresh', phone: '+79002222222', consent: true } as never, 'draft');

    // Состариваем одну запись на 20 дней.
    const oldFile = path.join(dataDir, 'quarantine', 'old.json');
    const old = Date.now() / 1000 - 20 * 24 * 60 * 60;
    utimesSync(oldFile, old, old);

    const { sweepQuarantine } = await import('../../../server/lead-flusher.mjs');
    const result = sweepQuarantine();

    expect(result.removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(path.join(dataDir, 'quarantine', 'fresh.json'))).toBe(true);

    // Удаление тоже попадает в журнал — история заявки не обрывается молча.
    const journal = readFileSync(path.join(dataDir, 'leads.jsonl'), 'utf-8');
    expect(journal).toContain('"event":"quarantine_purged"');
  });

  it('при TTL=0 не удаляет ничего', async () => {
    process.env.LEAD_QUARANTINE_TTL_DAYS = '0';
    const { quarantineLead } = await import('../lead-server/leads');
    quarantineLead({ lead_id: 'keep', phone: '+79001111111', consent: true } as never, 'draft');

    const file = path.join(dataDir, 'quarantine', 'keep.json');
    const old = Date.now() / 1000 - 999 * 24 * 60 * 60;
    utimesSync(file, old, old);

    const { sweepQuarantine } = await import('../../../server/lead-flusher.mjs');
    expect(sweepQuarantine().removed).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});
