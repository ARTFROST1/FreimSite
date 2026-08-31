// @vitest-environment jsdom
/**
 * Переход на страницу «Спасибо» после успешной отправки формы.
 *
 * Боевой разбор 25.08.2026: переход делался через `location.assign`, то есть
 * жёсткой перезагрузкой. Документ умирал целиком, а Вебвизор копит DOM в
 * буфере и шлёт порциями — всё несохранённое пропадало вместе со страницей.
 * В плеере запись визита обрывалась ровно на отправке формы, а сама страница
 * «Спасибо» открывалась пустой. Заявка, цель и просмотр при этом доезжали:
 * терялась только запись, по которой директолог проверяет, что человек
 * действительно заполнял форму.
 *
 * Теперь переход идёт КЛИКОМ ПО ССЫЛКЕ — тем же путём, что любая другая
 * ссылка сайта: ClientRouter делает клиентскую навигацию, документ живёт
 * дальше, запись не рвётся.
 *
 * Что здесь защищается:
 *  - переход именно кликом, а не перезагрузкой (иначе вернётся обрыв);
 *  - цель lead_submit уходит РАНЬШЕ перехода и ровно один раз;
 *  - забрал навигацию роутер — жёсткого перехода не происходит вовсе;
 *  - роутера нет — страховка всё равно уводит клиента на «Спасибо»,
 *    потому что застрять на форме после успешной заявки нельзя.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let assignMock: ReturnType<typeof vi.fn>;
/** Клики по ссылкам, которые ушли бы в навигацию (jsdom её не выполняет). */
let linkClicks: string[];
/** document живёт весь файл — слушатели снимаем, иначе текут между тестами. */
let listeners: Array<[string, EventListener]>;

function onDocument(type: string, fn: EventListener): void {
  document.addEventListener(type, fn);
  listeners.push([type, fn]);
}

function makeRedirectForm(): HTMLFormElement {
  document.body.innerHTML = `
    <form data-lead-form data-lead-source="calc" data-lead-success="redirect">
      <input name="phone" value="+7 (900) 123-45-67" />
      <input name="name" value="Артём" />
      <label><input type="checkbox" name="consent" checked /> ок</label>
      <p data-form-error hidden></p>
      <button type="submit" data-submit>Жду звонка</button>
    </form>`;
  return document.querySelector('form')!;
}

async function loadModule() {
  vi.resetModules();
  vi.stubEnv('PUBLIC_YANDEX_METRIKA_ID', '97654321');
  return import('../lead-form');
}

function goalsFired(): string[] {
  return ((window as unknown as { ym: ReturnType<typeof vi.fn> }).ym).mock.calls
    .filter((c) => c[1] === 'reachGoal')
    .map((c) => String(c[2]));
}

/** Прогоняет таймеры до выполнения условия (паузы ретраев + страховка). */
async function settleUntil(check: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await vi.runAllTimersAsync();
      check();
    },
    { timeout: 4000 },
  );
}

beforeEach(() => {
  sessionStorage.clear();
  linkClicks = [];
  assignMock = vi.fn();
  // jsdom не умеет навигацию: подменяем assign и ловим клики по ссылкам,
  // гася их, чтобы не сыпать "Not implemented: navigation".
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: assignMock, pathname: '/', search: '' },
  });
  listeners = [];
  onDocument('click', (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.('a');
    if (a) {
      linkClicks.push(a.getAttribute('href') ?? '');
      e.preventDefault();
    }
  });
  (window as unknown as { ym: unknown }).ym = vi.fn();
  (window as unknown as { __ymId: unknown }).__ymId = 97654321;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 201 })));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  for (const [type, fn] of listeners) document.removeEventListener(type, fn);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.body.innerHTML = '';
});

describe('переход на «Спасибо» после отправки', () => {
  it('уходит кликом по ссылке на /thanks/?from=calc, а не перезагрузкой', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeRedirectForm();
    initLeadForms();
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await settleUntil(() => expect(linkClicks.length).toBeGreaterThan(0));

    expect(linkClicks[0]).toBe('/thanks/?from=calc');
  });

  it('цель lead_submit уходит до перехода и ровно один раз', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeRedirectForm();
    initLeadForms();
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await settleUntil(() => expect(linkClicks.length).toBeGreaterThan(0));

    // Одношаговая форма шлёт оба факта: контакт получен и заявка отправлена.
    expect(goalsFired()).toEqual(['lead_contact', 'lead_submit']);
    // Клик один: страховка по таймауту не должна давать второй переход.
    expect(linkClicks).toHaveLength(1);
  });

  it('навигацию забрал ClientRouter — жёсткого перехода не происходит', async () => {
    // Роутер сообщает о себе синхронно в момент клика.
    onDocument('click', () => {
      document.dispatchEvent(new CustomEvent('astro:before-preparation'));
    });

    const { initLeadForms } = await loadModule();
    const form = makeRedirectForm();
    initLeadForms();
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await settleUntil(() => expect(linkClicks.length).toBeGreaterThan(0));
    await vi.runAllTimersAsync(); // прокручиваем страховку

    expect(assignMock).not.toHaveBeenCalled();
  });

  it('роутера нет — страховка всё равно уводит на «Спасибо»', async () => {
    const { initLeadForms } = await loadModule();
    const form = makeRedirectForm();
    initLeadForms();
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await settleUntil(() => expect(assignMock).toHaveBeenCalled());

    expect(assignMock).toHaveBeenCalledWith('/thanks/?from=calc');
  });

  it('navigateToThanks не роняет сценарий, если кликнуть ссылку не удалось', async () => {
    const { navigateToThanks } = await loadModule();
    const spy = vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('нет DOM');
    });

    expect(() => navigateToThanks('/thanks/?from=popup')).not.toThrow();
    spy.mockRestore();

    await vi.runAllTimersAsync();
    expect(assignMock).toHaveBeenCalledWith('/thanks/?from=popup');
  });
});
