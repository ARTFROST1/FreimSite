// @vitest-environment jsdom
/**
 * Ранняя фиксация контакта в ОДНОШАГОВОЙ форме (`data-lead-draft`).
 *
 * У двухшаговой формы момент «контакт получен» задаёт кнопка «Далее» — она
 * зовёт `submitLeadDraft()` руками. В одношаговой такой кнопки нет, поэтому
 * то же условие читается прямо из полей: телефон введён полностью И стоит
 * галочка согласия. С этой секунды есть и контакт, и правовое основание им
 * воспользоваться, поэтому лид сразу пишется черновиком на
 * `/api/lead/draft/`, а флашер через LEAD_FLUSH_MINUTES отправит его
 * менеджерам, даже если посетитель так и не нажал кнопку отправки.
 *
 * Атрибут — opt-in: формы без него (попапы, короткие CTA) работают как
 * раньше, одним `complete` без черновиков.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID = '9001234567';

function makeForm(attrs = 'data-lead-draft'): HTMLFormElement {
  document.body.innerHTML = `
    <form data-lead-form data-lead-source="cta" ${attrs}>
      <input name="phone" type="tel" />
      <input name="name" value="Артём" />
      <label><input type="checkbox" name="consent" /> согласие</label>
      <p data-form-error hidden></p>
      <button type="submit" data-submit>Оставить заявку</button>
    </form>`;
  return document.querySelector('form')!;
}

async function loadModule() {
  vi.resetModules();
  vi.stubEnv('PUBLIC_YANDEX_METRIKA_ID', '97654321');
  return import('../lead-form');
}

function typePhone(form: HTMLFormElement, digits: string): void {
  const phone = form.querySelector<HTMLInputElement>('input[name="phone"]')!;
  phone.value = digits;
  phone.dispatchEvent(new Event('input', { bubbles: true }));
}

function checkConsent(form: HTMLFormElement): void {
  const consent = form.querySelector<HTMLInputElement>('input[name="consent"]')!;
  consent.checked = true;
  consent.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Запросы на /api/lead/draft/ — именно черновики, не полные заявки. */
function draftCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/lead/draft/'));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  (window as any).ym = vi.fn();
  (window as any).__ymId = 97654321;
  fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('авточерновик по «телефон + согласие»', () => {
  it('полный телефон и галочка — контакт уходит на сервер', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();

    typePhone(form, VALID);
    checkConsent(form);
    await vi.runAllTimersAsync();

    expect(draftCalls(fetchMock)).toHaveLength(1);
    const body = JSON.parse(String((draftCalls(fetchMock)[0] as any[])[1].body));
    expect(body.phone).toBe('+79001234567');
    expect(body.consent).toBe(true);
    expect(body.source).toBe('cta');
    // Цель «контакт получен» — снова РАННЯЯ, как в двухшаговой форме.
    expect((window as any).ym).toHaveBeenCalledWith(
      97654321,
      'reachGoal',
      'lead_contact',
      { source: 'cta' },
      undefined,
    );
  });

  it('порядок не важен: сначала галочка, потом телефон', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();

    checkConsent(form);
    typePhone(form, VALID);
    await vi.runAllTimersAsync();

    expect(draftCalls(fetchMock)).toHaveLength(1);
  });

  it('телефон неполный — молчим, звонить некуда', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();

    typePhone(form, '90012');
    checkConsent(form);
    await vi.runAllTimersAsync();

    expect(draftCalls(fetchMock)).toHaveLength(0);
  });

  it('галочки нет — молчим, нет основания обрабатывать номер', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();

    typePhone(form, VALID);
    await vi.runAllTimersAsync();

    expect(draftCalls(fetchMock)).toHaveLength(0);
  });

  it('галочку сняли до конца паузы — черновик не уходит', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();

    typePhone(form, VALID);
    checkConsent(form);
    const consent = form.querySelector<HTMLInputElement>('input[name="consent"]')!;
    consent.checked = false;
    consent.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.runAllTimersAsync();

    expect(draftCalls(fetchMock)).toHaveLength(0);
  });

  it('правка номера после отправки не плодит вторых черновиков', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();

    typePhone(form, VALID);
    checkConsent(form);
    await vi.runAllTimersAsync();
    typePhone(form, '9997776655');
    await vi.runAllTimersAsync();

    expect(draftCalls(fetchMock)).toHaveLength(1);
  });

  it('человек закрывает вкладку, не дождавшись паузы — успеваем записать', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();

    typePhone(form, VALID);
    checkConsent(form);
    window.dispatchEvent(new Event('pagehide'));

    expect(draftCalls(fetchMock)).toHaveLength(1);
  });

  it('вкладку свернули на телефоне (pagehide может не прийти) — тоже успеваем', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeForm();
    initLeadForms();

    typePhone(form, VALID);
    checkConsent(form);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(draftCalls(fetchMock)).toHaveLength(1);
  });

  it('форма без data-lead-draft ведёт себя как раньше — черновиков нет', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeForm('');
    initLeadForms();

    typePhone(form, VALID);
    checkConsent(form);
    await vi.runAllTimersAsync();

    expect(draftCalls(fetchMock)).toHaveLength(0);
  });
});
