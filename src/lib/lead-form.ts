/**
 * ============================================================================
 *  lead-form.ts — shared progressive-enhancement engine for lead forms.
 * ----------------------------------------------------------------------------
 *  Any `<form data-lead-form data-lead-source="...">` gets:
 *    • a +7 phone mask (numeric keypad via inputmode=tel, autofill-friendly),
 *    • client-side validation with a strong consent-checkbox highlight,
 *    • UTM / client_id / page_url mirrored into hidden fields AND the JSON body,
 *    • fetch() submit with inline success/error — no page reload,
 *    • `lead_submit` conversion goal on success,
 *    • a session flag (`app_lead_submitted`) that silences lead popups,
 *    • an `app:lead-success` CustomEvent for parent components (popups).
 *
 *  ENDPOINTS. Пустой `PUBLIC_CONTACT_ENDPOINT` (дефолт) = встроенный
 *  лид-пайплайн v2: черновик шага 1 уходит на `/api/lead/draft/`, полная
 *  заявка — на `/api/lead/complete/` (hybrid-режим, роуты активируются из
 *  `src/pages/api/lead/*.ts.example`). Слэш на конце ОБЯЗАТЕЛЕН:
 *  `trailingSlash:'always'` отвечает 301 на URL без слэша, а 301 на POST
 *  теряет тело/метод в части клиентов. Непустой `PUBLIC_CONTACT_ENDPOINT` =
 *  внешний форм-бэкенд (Formspree и т.п.): полная заявка идёт туда, а
 *  черновики ОТКЛЮЧАЮТСЯ — внешние формо-приёмники про них не знают.
 *
 *  DEMO MODE. `PUBLIC_LEAD_DEMO_MODE=1` (или `true`) пропускает сетевой
 *  вызов целиком, печатает громкий `console.warn` (лид не должен теряться
 *  молча) и даёт остальному пути успеха (цель, session-флаг, redirect)
 *  отработать как при реальной отправке. Нужен для демо заказчику, пока
 *  бэкенд не подключён. В проде НЕ включать — см. `.env.example`.
 *
 *  Three success modes (form's `data-lead-success` attr):
 *    'inline'   — hide the form, reveal the sibling [data-form-success] block.
 *    'redirect' — navigate to /thanks/?from=<source> (conversion page).
 *    'event'    — hide the form, let the parent render success UI.
 *
 *  ATTACHMENTS: if the form contains an `<input type="file">` with files
 *  selected, the request switches from a JSON body to `multipart/form-data` —
 *  every text field is appended as a string field, plus one `attachments`
 *  entry per file. A form with no file input (or none selected) keeps the
 *  plain JSON path unchanged.
 *  Сам интерфейс выбора (скрепка, drag&drop, лимиты, плитки превью) — это
 *  `components/ui/LeadAttachments.astro`; он переписывает `files` этого самого
 *  input'а через `DataTransfer`, поэтому сюда приезжает уже отфильтрованный
 *  по лимитам набор. Движок формы про лимиты не знает и знать не должен:
 *  единая точка правды — `lib/lead-attachments.ts`, последнее слово — сервер.
 *  Черновики (`/api/lead/draft/`) остаются JSON: файлы уходят только с полной
 *  заявкой.
 *
 *  initLeadForms() is idempotent — call on load + astro:page-load +
 *  astro:after-swap; it enhances every not-yet-enhanced form.
 * ============================================================================
 */
import { initUTMTracking, getStoredUTMParams, getClientId } from './utm';
import { reachGoal, GOALS } from './analytics';

const ENDPOINT = import.meta.env.PUBLIC_CONTACT_ENDPOINT || '/api/lead/complete/';
const DRAFT_ENDPOINT = import.meta.env.PUBLIC_CONTACT_ENDPOINT ? null : '/api/lead/draft/';
const THANKS_URL = '/thanks/';

/** See DEMO MODE doc-comment above. Off unless explicitly set to '1'/'true'. */
const DEMO_MODE = /^(1|true)$/i.test(String(import.meta.env.PUBLIC_LEAD_DEMO_MODE ?? '').trim());

/**
 * Поля шага 2 — расширяйте/сокращайте под проект, зеркально серверной схеме
 * в lead-server/leads.ts (completeSchema). Каждое имя читается из
 * input/textarea формы и, если заполнено, уходит в тело полной заявки.
 */
const STEP2_FIELDS = ['message', 'config', 'type', 'prefill', 'case', 'contactMethod'] as const;

/**
 * Сабмит с повторами. Сеть моргнула или сервер ответил 5xx — пробуем ещё
 * дважды с нарастающими паузами. Для сервера это безопасно: `lead_id` формы
 * стабилен (см. leadIdOf), а `/api/lead/complete/` сшивает повтор с уже
 * записанной заявкой по нему — сценарий «заявка записалась, а ответ не
 * дошёл» даёт дополнение, а не дубль. 4xx (422 — не прошла валидация,
 * 429 — упёрлись в лимит) НЕ повторяем: это не транзиентные ошибки, повтор
 * их не вылечит, а лимит только усугубит.
 *
 * Значения пауз — компромисс: суммарно ~2.5с, дольше держать посетителя перед
 * кнопкой «Отправка…» нельзя.
 */
const RETRY_DELAYS_MS = [700, 1800];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function postWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await wait(RETRY_DELAYS_MS[attempt - 1]!);
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('network');
}

/** /thanks/?from=<source> — lets the conversion page (and its `lead_thankyou`
 *  goal) attribute the lead to the form that sent it. See src/pages/thanks.astro. */
/**
 * Переход на страницу благодарности — КЛИКОМ ПО ССЫЛКЕ, а не перезагрузкой.
 *
 * Зачем так, а не `location.assign` (правка 25.08.2026, боевой разбор):
 * (docs/ANALYTICS-PITFALLS.md №11) жёсткий переход убивает документ целиком, а Вебвизор копит DOM в буфере и
 * отправляет порциями. Всё, что не успело уйти, пропадает вместе со
 * страницей: запись визита обрывалась ровно на отправке формы, а сама
 * страница «Спасибо» открывалась в плеере пустой. Заявка, цель и просмотр
 * при этом доезжали — терялось только «кино», по которому директолог
 * проверяет, что человек реально заполнял форму.
 *
 * Клик по обычной ссылке перехватывает ClientRouter и делает клиентскую
 * навигацию: документ живёт дальше, Вебвизор пишет непрерывно, а просмотр
 * страницы считает ручной хит на `astro:page-load` (AnalyticsRouterHit) —
 * ровно как при переходе по любой другой ссылке сайта. Именно поэтому взят
 * клик, а не `navigate()` из `astro:transitions/client`: тот же путь, что у
 * всех остальных переходов, без отдельной ветки поведения и без импорта
 * виртуального модуля Astro в общую библиотеку.
 *
 * Деградация встроенная: нет роутера — браузер просто уйдёт по href сам,
 * как по любой ссылке. Страховка ниже — на случай, если клик не увели ни
 * роутер, ни браузер (перехватчик на странице, блокировка): через 400 мс
 * уходим жёстко. `astro:before-preparation` стреляет синхронно в момент,
 * когда роутер забрал навигацию себе, — это и есть признак, что страховка
 * не нужна.
 */
export function navigateToThanks(url: string): void {
  let handledByRouter = false;
  const onRouterStart = (): void => {
    handledByRouter = true;
  };
  try {
    document.addEventListener('astro:before-preparation', onRouterStart, { once: true });
    const link = document.createElement('a');
    link.href = url;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch {
    /* ссылку не удалось создать/кликнуть — уйдём по страховке ниже */
  }
  window.setTimeout(() => {
    document.removeEventListener('astro:before-preparation', onRouterStart);
    if (!handledByRouter) window.location.assign(url);
  }, 400);
}

function thanksUrl(source: string): string {
  return `${THANKS_URL}?from=${encodeURIComponent(source)}`;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** Format up to 10 subscriber digits into +7 (XXX) XXX-XX-XX. */
function formatPhone(digits: string): string {
  const d = digits.slice(0, 10);
  let result = '+7';
  if (d.length === 0) return result + ' (';
  result += ' (' + d.slice(0, 3);
  if (d.length >= 3) result += ') ';
  if (d.length > 3) result += d.slice(3, 6);
  if (d.length >= 6) result += '-';
  if (d.length > 6) result += d.slice(6, 8);
  if (d.length >= 8) result += '-';
  if (d.length > 8) result += d.slice(8, 10);
  return result;
}

function normalizePhone(masked: string): string {
  const all = digitsOnly(masked);
  return all.startsWith('7') ? '+' + all : '+7' + all;
}

/** Стабильный lead_id формы: связывает черновик шага 1 и полную заявку. */
function leadIdOf(form: HTMLFormElement): string {
  if (!form.dataset.leadId) {
    form.dataset.leadId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
  return form.dataset.leadId;
}

/** Атрибуция + контакт — общая часть черновика и полной заявки. */
/**
 * Ловушка для ботов: скрытое поле `hp_token`. Человек его не видит (оно за
 * пределами экрана, вне таб-порядка), а автоматический заполнитель форм —
 * заполняет. Значение уезжает на сервер, который кладёт такую заявку в
 * карантин вместо чата менеджеров.
 *
 * Имя намеренно бессмысленное. Предыдущая версия называлась `company` и несла
 * подпись «Компания» — по ней автозаполнение браузера узнавало поле и
 * подставляло организацию у ЖИВЫХ людей (инцидент 21.08.2026). Никаких
 * `name`, `email`, `phone`, `company`, `address` в имени ловушки быть не
 * должно: браузеры ориентируются на них, а `autocomplete="off"` игнорируют.
 */
function addTrapField(form: HTMLFormElement, body: Record<string, unknown>): void {
  const trap = form.querySelector<HTMLInputElement>('input[name="hp_token"]');
  if (trap?.value) body.hp_token = trap.value;
}

function baseBody(form: HTMLFormElement, source: string): Record<string, unknown> {
  const phoneInput = form.querySelector<HTMLInputElement>('input[name="phone"]');
  const nameInput = form.querySelector<HTMLInputElement>('input[name="name"]');
  const body: Record<string, unknown> = {
    lead_id: leadIdOf(form),
    phone: normalizePhone(phoneInput?.value ?? ''),
    consent: true,
    page_url: window.location.href,
    source,
    ...Object.fromEntries(Object.entries(getStoredUTMParams()).filter(([, v]) => v)),
  };
  const clientId = getClientId();
  if (clientId) body.client_id = clientId;
  if (nameInput?.value) body.name = nameInput.value.trim();
  return body;
}

/**
 * Ранняя фиксация лида (шаг 1 пройден: телефон + согласие). Вызывается
 * СНАРУЖИ движка — двухшаговая форма зовёт после успешной валидации шага 1.
 * Не блокирует переход на шаг 2 (fire-and-forget, keepalive переживает
 * уход со страницы). Успех/демо → цель `lead_contact`. Провал сети — не
 * страшно: полная заявка (или её отсутствие) всё равно несёт все поля,
 * а черновик — только страховка от «застрял на шаге 2».
 */
export function submitLeadDraft(form: HTMLFormElement): void {
  if (form.dataset.draftSent === 'true') return;
  form.dataset.draftSent = 'true';

  const source = form.getAttribute('data-lead-source') || 'form';
  const fire = (): void => reachGoal(GOALS.LEAD_CONTACT, { source });

  if (DEMO_MODE) {
    // eslint-disable-next-line no-console
    console.warn(`[lead-form] ДЕМО-РЕЖИМ: черновик лида НЕ отправлен (source=${source}).`);
    fire();
    return;
  }
  if (!DRAFT_ENDPOINT) {
    fire(); // внешний бекенд без черновиков — цель всё равно фиксируем
    return;
  }

  const body = baseBody(form, source);
  addTrapField(form, body);

  fetch(DRAFT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  })
    .then((res) => {
      if (res.ok) fire();
      else form.dataset.draftSent = 'false';
    })
    .catch(() => {
      form.dataset.draftSent = 'false'; // сеть моргнула — попробуем при повторном «Далее»
    });
}

function enhance(form: HTMLFormElement): void {
  if (form.dataset.enhanced === 'true') return;
  form.dataset.enhanced = 'true';

  const source = form.getAttribute('data-lead-source') || 'form';
  const successMode = form.getAttribute('data-lead-success') || 'inline';

  // Mirror attribution into hidden fields (for the no-JS <form> POST path).
  initUTMTracking();
  const setHidden = (name: string, value?: string): void => {
    const el = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (el && value) el.value = value;
  };
  const utm = getStoredUTMParams();
  (Object.keys(utm) as (keyof typeof utm)[]).forEach((k) => setHidden(k, utm[k]));
  setHidden('client_id', getClientId());
  setHidden('page_url', window.location.href);

  const phoneInput = form.querySelector<HTMLInputElement>('input[name="phone"]');
  const consentInput = form.querySelector<HTMLInputElement>('input[name="consent"]');
  const submitBtn = form.querySelector<HTMLButtonElement>('[data-submit]');
  // ПРАВИЛО: пишем ошибку во ВСЕ [data-form-error] формы, не только в первый.
  // У многошаговой формы первый блок ошибки может жить в скрытом fieldset
  // неактивного шага — ошибка сабмита (422/429/сеть) ушла бы в невидимый
  // элемент и форма «молча ничего не делала». Видим ровно тот блок, чей шаг
  // сейчас активен.
  const errorEls = Array.from(form.querySelectorAll<HTMLElement>('[data-form-error]'));
  const successEl =
    form.parentElement?.querySelector<HTMLElement>('[data-form-success]') ?? null;
  if (!phoneInput || !submitBtn) return;

  // ── Consent highlight ──
  const consentLabel = consentInput?.closest('label') ?? null;
  const setConsentError = (on: boolean): void => {
    consentLabel?.classList.toggle('consent-error', on);
  };
  consentInput?.addEventListener('change', () => {
    if (consentInput.checked) setConsentError(false);
  });

  // ── Phone mask ──
  phoneInput.addEventListener('focus', () => {
    if (!phoneInput.value) phoneInput.value = '+7 (';
  });
  phoneInput.addEventListener('input', () => {
    const raw = phoneInput.value;
    if (raw.length < 3) {
      phoneInput.value = '+7 (';
      return;
    }
    const all = digitsOnly(raw);
    const subscriber = all.startsWith('7') ? all.slice(1) : all;
    phoneInput.value = formatPhone(subscriber);
    phoneInput.setAttribute('aria-invalid', 'false');
  });

  const showError = (msg: string): void => {
    errorEls.forEach((el) => {
      el.textContent = msg;
      el.hidden = false;
    });
  };
  const clearError = (): void => {
    setConsentError(false);
    errorEls.forEach((el) => {
      el.hidden = true;
      el.textContent = '';
    });
    phoneInput.setAttribute('aria-invalid', 'false');
  };

  // ── Ранняя фиксация контакта: `data-lead-draft` ─────────────────────
  // Двухшаговая форма отмечает «шаг 1 пройден» кнопкой «Далее» — она зовёт
  // `submitLeadDraft()` руками (см. §4 рецепта lead-pipeline). У одношаговой
  // формы такой кнопки нет, поэтому то же условие читается прямо из полей:
  // телефон введён полностью И стоит галочка согласия. С этого момента есть и
  // контакт, и правовое основание им воспользоваться — галочка и есть то
  // предварительное согласие, которого требует ст. 18 ФЗ «О рекламе», а факт
  // её проставления фиксируется на сервере вместе со временем, IP и страницей.
  // Поэтому лид сразу пишется черновиком, и флашер отправит его менеджерам
  // через LEAD_FLUSH_MINUTES, даже если кнопку отправки так и не нажали.
  //
  // Opt-in, а не поведение по умолчанию: попапы и короткие CTA-формы обычно
  // не должны ничего писать до явного действия посетителя.
  if (form.hasAttribute('data-lead-draft')) {
    // Пауза после последнего нажатия клавиши. Без неё на сервер уедет номер,
    // который человек ещё дописывает или правит, — и менеджер позвонит не туда.
    const DRAFT_DELAY_MS = 1200;
    let draftTimer = 0;

    const contactReady = (): boolean => {
      const digits = digitsOnly(phoneInput.value);
      return (
        digits.length === 11 && digits.startsWith('7') && Boolean(consentInput?.checked)
      );
    };

    const sendDraftNow = (): void => {
      window.clearTimeout(draftTimer);
      draftTimer = 0;
      if (contactReady()) submitLeadDraft(form);
    };

    const scheduleDraft = (): void => {
      window.clearTimeout(draftTimer);
      draftTimer = 0;
      if (form.dataset.draftSent === 'true' || !contactReady()) return;
      draftTimer = window.setTimeout(sendDraftNow, DRAFT_DELAY_MS);
    };

    phoneInput.addEventListener('input', scheduleDraft);
    consentInput?.addEventListener('change', scheduleDraft);
    // Уход со страницы раньше, чем истекла пауза: `submitLeadDraft` шлёт с
    // `keepalive`, поэтому запрос переживает выгрузку. `visibilitychange`
    // нужен отдельно — на мобильных `pagehide` приходит не всегда.
    window.addEventListener('pagehide', sendDraftNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') sendDraftNow();
    });
  }

  // ── Submit ──
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();

    const phoneDigits = digitsOnly(phoneInput.value);
    if (phoneDigits.length !== 11 || !phoneDigits.startsWith('7')) {
      phoneInput.setAttribute('aria-invalid', 'true');
      showError('Введите корректный номер телефона.');
      phoneInput.focus();
      return;
    }
    if (consentInput && !consentInput.checked) {
      setConsentError(true);
      consentLabel?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      showError('Отметьте согласие на обработку персональных данных.');
      return;
    }

    // ПРАВИЛО: сохраняем/восстанавливаем `innerHTML`, а не `textContent` —
    // у кнопок сабмита часто есть вложенная разметка (`<span data-cms=…>` +
    // декоративная стрелка), и `textContent` при восстановлении убил бы её,
    // оставив голый текст. Для чисто текстовых кнопок оба пути эквивалентны.
    const originalLabel = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправка…';

    // Общая часть (lead_id + контакт + атрибуция) — та же, что у черновика:
    // сервер сошьёт полную заявку с черновиком шага 1 по lead_id.
    const body = baseBody(form, source);
    addTrapField(form, body);

    // Опциональные поля шага 2 (STEP2_FIELDS): читаются, только если форма
    // их рендерит и посетитель их заполнил. Скрытые input'ы (например,
    // `config`, синхронизируемый с клиентским состоянием конструктора) —
    // тот же паттерн.
    for (const name of STEP2_FIELDS) {
      const field = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `input[name="${name}"], textarea[name="${name}"]`,
      );
      if (field?.value) body[name] = field.value.trim();
    }

    // Attachments: any `<input type="file">` with files picked switches the
    // request to multipart/form-data so the browser can actually upload them.
    const fileInput = form.querySelector<HTMLInputElement>('input[type="file"]');
    const files = fileInput?.files;

    try {
      let res: Response | null = null;
      if (DEMO_MODE) {
        // Loud and unmissable on purpose — a silently-dropped lead is worse
        // than a noisy console during a client demo. See DEMO MODE doc-comment.
        // eslint-disable-next-line no-console
        console.warn(
          `[lead-form] ДЕМО-РЕЖИМ: заявка НЕ отправлена ни на какой сервер ` +
            `(PUBLIC_LEAD_DEMO_MODE включён, PUBLIC_CONTACT_ENDPOINT=${JSON.stringify(
              import.meta.env.PUBLIC_CONTACT_ENDPOINT || '',
            )}). source=${JSON.stringify(source)}, phone=${JSON.stringify(body.phone)}. ` +
            `Отключите PUBLIC_LEAD_DEMO_MODE перед реальным запуском (см. .env.example).`,
        );
      } else if (files && files.length > 0) {
        const fd = new FormData();
        Object.entries(body).forEach(([key, value]) => {
          if (value !== undefined && value !== null) fd.append(key, String(value));
        });
        Array.from(files).forEach((file) => fd.append('attachments', file));
        // No explicit Content-Type: the browser sets the multipart boundary.
        res = await postWithRetry(ENDPOINT, { method: 'POST', headers: { Accept: 'application/json' }, body: fd });
      } else {
        res = await postWithRetry(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (res && !res.ok) {
        throw new Error(
          res.status === 429
            ? 'Слишком много попыток. Попробуйте через минуту.'
            : 'Не удалось отправить заявку. Позвоните нам или попробуйте позже.',
        );
      }

      // `lead_contact` = «контакт получен» и служит главной РАННЕЙ конверсией
      // (на неё обычно оптимизируют рекламу). У двухшаговой формы её стреляет
      // черновик шага 1, у одношаговой с `data-lead-draft` — момент «телефон
      // + согласие». Если ни того, ни другого не было, контакт получен ровно
      // сейчас: без этой строки ранняя цель у простых форм не срабатывала бы
      // никогда, и оптимизировать рекламу было бы не на что.
      if (form.dataset.draftSent !== 'true') {
        form.dataset.draftSent = 'true';
        reachGoal(GOALS.LEAD_CONTACT, { source });
      }

      // Silence lead popups for the rest of the session; notify listeners.
      try {
        sessionStorage.setItem('app_lead_submitted', '1');
      } catch {
        /* private mode */
      }
      document.dispatchEvent(
        new CustomEvent('app:lead-success', { detail: { source, mode: successMode } }),
      );

      if (successMode === 'redirect') {
        // Цель и переход: уходим на страницу «Спасибо» только когда Метрика
        // подтвердила отправку. Прямой переход сразу за reachGoal убивает
        // цель вместе с выгружаемой страницей (docs/ANALYTICS-PITFALLS.md №1).
        // Страховка по таймауту: клиента нельзя держать из-за аналитики.
        let redirected = false;
        const go = (): void => {
          if (redirected) return;
          redirected = true;
          navigateToThanks(thanksUrl(source));
        };
        reachGoal(GOALS.LEAD_SUBMIT, { source }, go);
        window.setTimeout(go, 1200);
        return;
      }

      reachGoal(GOALS.LEAD_SUBMIT, { source });

      form.hidden = true;
      if (successMode === 'inline' && successEl) {
        successEl.hidden = false;
        successEl.focus?.();
      }
      // successMode === 'event' → the parent (popup) renders its own success UI.
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Произошла ошибка. Попробуйте позже.');
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalLabel;
    }
  });
}

/** Enhance every not-yet-enhanced lead form currently in the DOM. */
export function initLeadForms(): void {
  document.querySelectorAll<HTMLFormElement>('[data-lead-form]').forEach(enhance);
}
