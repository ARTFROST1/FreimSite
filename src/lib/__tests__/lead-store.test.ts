/**
 * Тесты хранилища лидов (lead-server/leads.ts): upsert черновика без сдвига
 * таймера, merge complete-заявки с черновиком, дедуп повторного complete.
 * Контракт файлов должен совпадать с ожиданиями флашера — см. соседний
 * lead-flusher.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dataDir: string;

async function loadStore() {
  vi.resetModules();
  process.env.LEAD_DATA_DIR = dataDir;
  return import('../lead-server/leads');
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'lead-store-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const ID = '55555555-5555-4555-8555-555555555555';

describe('saveDraft', () => {
  it('пишет черновик в формате флашера: { lead, due_at, attempts }', async () => {
    const { saveDraft } = await loadStore();
    saveDraft({ lead_id: ID, phone: '+79001234567', source: 'calc' } as any);

    const record = JSON.parse(readFileSync(path.join(dataDir, 'drafts', `${ID}.json`), 'utf-8'));
    expect(record.lead.lead_id).toBe(ID);
    expect(record.lead.created_at).toBeTruthy();
    expect(record.attempts).toBe(0);
    // Таймер ≈ +15 минут (дефолт LEAD_FLUSH_MINUTES).
    const dueIn = new Date(record.due_at).getTime() - Date.now();
    expect(dueIn).toBeGreaterThan(14 * 60_000);
    expect(dueIn).toBeLessThan(16 * 60_000);
  });

  it('повторный draft обновляет поля, но НЕ сдвигает due_at (таймер не переармливается)', async () => {
    const { saveDraft } = await loadStore();
    saveDraft({ lead_id: ID, phone: '+79001234567', source: 'calc' } as any);
    const first = JSON.parse(readFileSync(path.join(dataDir, 'drafts', `${ID}.json`), 'utf-8'));

    saveDraft({ lead_id: ID, phone: '+79001234567', name: 'Иван', source: 'calc' } as any);
    const second = JSON.parse(readFileSync(path.join(dataDir, 'drafts', `${ID}.json`), 'utf-8'));

    expect(second.lead.name).toBe('Иван');
    expect(second.due_at).toBe(first.due_at);
    expect(second.lead.created_at).toBe(first.lead.created_at);
  });
});

describe('completeLead', () => {
  it('мержит черновик с полной заявкой (complete побеждает), снимает с таймера', async () => {
    const { saveDraft, completeLead } = await loadStore();
    saveDraft({ lead_id: ID, phone: '+79001234567', source: 'calc', utm_source: 'yandex' } as any);

    const result = completeLead({ lead_id: ID, phone: '+79001234567', source: 'calc', message: 'Хочу заказать' } as any);

    expect(result).not.toBeNull();
    expect(result!.updated).toBe(false);
    expect(result!.lead.message).toBe('Хочу заказать');
    expect((result!.lead as any).utm_source).toBe('yandex'); // поле черновика пережило merge
    expect(result!.lead.completed_at).toBeTruthy();
    // Черновик снят с таймера, маркер «отправлено» записан.
    expect(existsSync(path.join(dataDir, 'drafts', `${ID}.json`))).toBe(false);
    expect(existsSync(path.join(dataDir, 'drafts', 'sent', `${ID}.json`))).toBe(true);
  });

  it('повторный complete того же lead_id без новых данных — дедуп (null)', async () => {
    const { completeLead } = await loadStore();
    const first = completeLead({ lead_id: ID, phone: '+79001234567', source: 'popup' } as any);
    const second = completeLead({ lead_id: ID, phone: '+79001234567', source: 'popup' } as any);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('поздний complete после отправки — updated=true и merge данных', async () => {
    const { completeLead } = await loadStore();
    // Лид уже ушёл ботам (как после авто-флаша: телефон есть, деталей нет).
    completeLead({ lead_id: ID, phone: '+79001234567', source: 'calc' } as any);

    const late = completeLead({
      lead_id: ID,
      phone: '+79001234567',
      source: 'calc',
      message: 'Дожал форму',
      type: 'demo',
    } as any);

    expect(late).not.toBeNull();
    expect(late!.updated).toBe(true);
    expect(late!.lead.message).toBe('Дожал форму');
    expect(late!.lead.type).toBe('demo');
    expect(late!.lead.updated_at).toBeTruthy();
    // Отправленная версия перезаписана дополненной.
    const sent = JSON.parse(
      readFileSync(path.join(dataDir, 'drafts', 'sent', `${ID}.json`), 'utf-8'),
    );
    expect(sent.message).toBe('Дожал форму');
  });

  it('поздний complete с новыми вложениями — updated=true, вложения мержатся', async () => {
    const { completeLead } = await loadStore();
    completeLead({
      lead_id: ID,
      phone: '+79001234567',
      source: 'calc',
      attachments: [{ path: `attachments/${ID}/1.jpg`, name: 'a.jpg', size: 10, mime: 'image/jpeg' }],
    } as any);

    const late = completeLead({
      lead_id: ID,
      phone: '+79001234567',
      source: 'calc',
      attachments: [
        { path: `attachments/${ID}/1.jpg`, name: 'a.jpg', size: 10, mime: 'image/jpeg' },
        { path: `attachments/${ID}/2.pdf`, name: 'b.pdf', size: 20, mime: 'application/pdf' },
      ],
    } as any);

    expect(late).not.toBeNull();
    expect(late!.updated).toBe(true);
    expect(late!.lead.attachments!.map((a: any) => a.path)).toEqual([
      `attachments/${ID}/1.jpg`,
      `attachments/${ID}/2.pdf`,
    ]);
  });

  it('complete без черновика (попап) работает сам по себе', async () => {
    const { completeLead } = await loadStore();
    const result = completeLead({ lead_id: ID, phone: '+79001234567', source: 'popup', name: 'Гость' } as any);
    expect(result!.lead.name).toBe('Гость');
    expect(result!.updated).toBe(false);
  });
});

describe('draftSchema / completeSchema', () => {
  it('принимает валидный черновик и режет мусорный телефон', async () => {
    const { draftSchema } = await loadStore();
    expect(draftSchema.safeParse({ phone: '+7 (900) 123-45-67', source: 'calc' }).success).toBe(true);
    expect(draftSchema.safeParse({ phone: '123', source: 'calc' }).success).toBe(false);
  });

  it('complete принимает поля шага 2 (type/message/contactMethod/prefill/case)', async () => {
    const { completeSchema } = await loadStore();
    const parsed = completeSchema.safeParse({
      phone: '+79001234567',
      type: 'demo',
      message: 'по фото',
      contactMethod: 'messenger',
      prefill: 'demo',
      case: 'Пример из галереи',
    });
    expect(parsed.success).toBe(true);
  });
});
