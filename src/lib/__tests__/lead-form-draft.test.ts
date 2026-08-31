// @vitest-environment jsdom
/**
 * Тесты ранней фиксации лида (submitLeadDraft, lead-form.ts):
 * черновик уходит на /api/lead/draft/ с lead_id/телефоном/атрибуцией,
 * успех стреляет цель lead_contact, повторный вызов гардится dataset'ом,
 * сетевой провал снимает гард (повторное «Далее» попробует ещё раз).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeForm(): HTMLFormElement {
  document.body.innerHTML = `
    <form data-lead-form data-lead-source="calc">
      <input name="phone" value="+7 (900) 123-45-67" />
      <input name="name" value="Иван" />
    </form>`;
  return document.querySelector('form')!;
}

async function loadModule() {
  vi.resetModules();
  vi.stubEnv('PUBLIC_YANDEX_METRIKA_ID', '97654321');
  return import('../lead-form');
}

beforeEach(() => {
  sessionStorage.clear();
  (window as any).ym = vi.fn();
  (window as any).__ymId = 97654321;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('submitLeadDraft', () => {
  it('шлёт черновик на /api/lead/draft/ (keepalive) и стреляет lead_contact', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{"ok":true}', { status: 201 });
    }));

    const { submitLeadDraft } = await loadModule();
    const form = makeForm();
    submitLeadDraft(form);
    await vi.waitFor(() => expect((window as any).ym).toHaveBeenCalled());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/lead/draft/');
    expect(calls[0].init.keepalive).toBe(true);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.phone).toBe('+79001234567');
    expect(body.name).toBe('Иван');
    expect(body.source).toBe('calc');
    expect(body.lead_id).toMatch(/^[0-9a-f-]{36}$/);
    // Цель lead_contact с источником.
    // Пятый аргумент — callback Метрики. Здесь undefined: черновик никуда не
    // уводит со страницы, ждать нечего. Он обязателен там, где сразу за целью
    // идёт переход (см. lead_submit в lead-form.ts).
    expect((window as any).ym).toHaveBeenCalledWith(
      97654321,
      'reachGoal',
      'lead_contact',
      { source: 'calc' },
      undefined,
    );
    // lead_id закреплён на форме — полная заявка пошлёт тот же.
    expect(form.dataset.leadId).toBe(body.lead_id);
  });

  it('повторный вызов после успеха — no-op (гард draftSent)', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const { submitLeadDraft } = await loadModule();
    const form = makeForm();
    submitLeadDraft(form);
    await vi.waitFor(() => expect(form.dataset.draftSent).toBe('true'));
    submitLeadDraft(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('сетевой провал снимает гард — следующее «Далее» повторит попытку', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const { submitLeadDraft } = await loadModule();
    const form = makeForm();
    submitLeadDraft(form);
    await vi.waitFor(() => expect(form.dataset.draftSent).toBe('false'));
    // Цель не стреляла (черновик не записан).
    expect((window as any).ym).not.toHaveBeenCalled();
  });
});
