// @vitest-environment jsdom
/**
 * Сабмит формы: повторы при транзиентных сбоях и цели Метрики.
 *
 *  - сеть моргнула / 5xx — движок повторяет запрос (до 3 попыток), `lead_id`
 *    остаётся тем же, поэтому сервер сшивает повтор с уже записанной заявкой
 *    и дубля не возникает;
 *  - 4xx (422/429) не повторяем — это не транзиентная ошибка;
 *  - успех без черновика стреляет И `lead_contact`, И `lead_submit`:
 *    у одношаговой формы без `data-lead-draft` контакт получен ровно в
 *    момент отправки, и ранняя цель не должна пропасть;
 *  - если черновик уже ушёл, `lead_contact` не дублируется.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeForm(): HTMLFormElement {
  document.body.innerHTML = `
    <div>
      <form data-lead-form data-lead-source="cta" data-lead-success="inline">
        <input name="phone" value="+7 (900) 123-45-67" />
        <input name="name" value="Артём" />
        <label><input type="checkbox" name="consent" checked /> ок</label>
        <p data-form-error hidden></p>
        <button type="submit" data-submit>Оставить заявку</button>
      </form>
      <div data-form-success hidden>Спасибо</div>
    </div>`;
  return document.querySelector('form')!;
}

async function loadModule() {
  vi.resetModules();
  vi.stubEnv('PUBLIC_YANDEX_METRIKA_ID', '97654321');
  return import('../lead-form');
}

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

/** Крутим фейковые таймеры (паузы между попытками) до выполнения условия. */
async function settleUntil(check: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await vi.runAllTimersAsync();
      check();
    },
    { timeout: 4000 },
  );
}

function goalsFired(): string[] {
  return ((window as any).ym as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => c[1] === 'reachGoal')
    .map((c) => String(c[2]));
}

beforeEach(() => {
  sessionStorage.clear();
  (window as any).ym = vi.fn();
  (window as any).__ymId = 97654321;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('submit с ретраями', () => {
  it('сетевой сбой на первой попытке → повтор → успех с тем же lead_id', async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      n += 1;
      if (n === 1) throw new TypeError('Failed to fetch');
      return new Response('{"ok":true}', { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();
    submit(form);

    await settleUntil(() => expect(form.hidden).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(JSON.parse(bodies[0]).lead_id).toBe(JSON.parse(bodies[1]).lead_id);
    expect(document.querySelector<HTMLElement>('[data-form-success]')!.hidden).toBe(false);
    expect(goalsFired()).toEqual(['lead_contact', 'lead_submit']);
  });

  it('5xx дважды → третья попытка успешна', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      return n < 3
        ? new Response('oops', { status: 502 })
        : new Response('{"ok":true}', { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();
    submit(form);

    await settleUntil(() => expect(form.hidden).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('429 — без повторов, ошибка показана, кнопка снова активна', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":false}', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();
    submit(form);

    const err = form.querySelector<HTMLElement>('[data-form-error]')!;
    await settleUntil(() => expect(err.hidden).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.textContent).toMatch(/много попыток/);
    expect(form.querySelector<HTMLButtonElement>('[data-submit]')!.disabled).toBe(false);
    expect(form.hidden).toBe(false);
    expect(goalsFired()).toEqual([]);
  });

  it('три сбоя подряд → ошибка, без зацикливания', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();
    submit(form);

    const err = form.querySelector<HTMLElement>('[data-form-error]')!;
    await settleUntil(() => expect(err.hidden).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(form.hidden).toBe(false);
  });

  it('черновик уже ушёл (draftSent) → lead_contact не дублируется', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 201 })));

    const { initLeadForms } = await loadModule();
    const form = makeForm();
    form.dataset.draftSent = 'true';
    initLeadForms();
    submit(form);

    await vi.waitFor(() => expect(form.hidden).toBe(true));
    expect(goalsFired()).toEqual(['lead_submit']);
  });
});
