/**
 * ============================================================================
 *  ANALYTICS — thin, provider-agnostic wrapper (Yandex Metrika default).
 * ----------------------------------------------------------------------------
 *  The counter id comes from PUBLIC_YANDEX_METRIKA_ID. If it's empty the
 *  wrapper becomes a no-op, so the site works fine with tracking disabled.
 *
 *  Conversion goals live in one place (GOALS). Track a goal from any client
 *  script with `reachGoal(GOALS.LEAD_SUBMIT)` or declaratively in markup with
 *  `data-goal="..."` (see BaseLayout's delegated click handler).
 * ============================================================================
 */

export const METRIKA_ID: number | null = (() => {
  const raw = import.meta.env.PUBLIC_YANDEX_METRIKA_ID;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
})();

/**
 * Central registry of conversion goals — ПОЛНЫЙ список целей сайта.
 * Каждую нужно завести в интерфейсе Метрики как «JavaScript-событие»
 * с идентификатором = значению ниже (см. docs/recipes/metrika-guide.md);
 * не заведена — reachGoal уходит в пустоту без ошибок.
 *
 * Инлайн- и бандл-скрипты компонентов используют те же имена строками:
 * ConversionTracking.astro (phone_click / messenger_click / social_click /
 * data-goal), EngagementTracking.astro (engaged_visitor / deep_scroll),
 * thanks.astro (lead_thankyou). Меняешь имя здесь — проверь grep'ом по строке.
 *
 * Ненужные проекту цели удаляй вместе с их потребителями (grep по значению).
 */
export const GOALS = {
  /**
   * Шаг 1 двухшаговой формы пройден: телефон + согласие получены, черновик
   * лида записан на сервер — самая ранняя реальная конверсия, телефон уже
   * у нас, даже если шаг 2 бросят (см. recipes/lead-pipeline.md).
   * В одношаговой конфигурации формы не используется.
   */
  LEAD_CONTACT: 'lead_contact',
  /** Полная заявка отправлена (lead-form.ts, {source}). */
  LEAD_SUBMIT: 'lead_submit',
  /** Показ страницы /thanks/ (чистая URL-конверсия для рекламных кабинетов). */
  LEAD_THANKYOU: 'lead_thankyou',
  /** Открытие лид-попапа ({source}). */
  POPUP_OPEN: 'popup_open',
  /** Клик по tel: — автодетект в ConversionTracking. */
  PHONE_CLICK: 'phone_click',
  /** Клик в мессенджер (whatsapp/telegram/max) — автодетект по href. */
  MESSENGER_CLICK: 'messenger_click',
  /** Клик в соцсеть (vk/instagram/youtube) — автодетект по href. */
  SOCIAL_CLICK: 'social_click',
  /** Клик по CTA-кнопкам (data-goal, {source}). */
  CTA_CLICK: 'cta_click',
  /** Полноэкранный просмотр фото (Lightbox, {group: product|gallery}). */
  GALLERY_VIEW: 'gallery_view',
  /** Запуск видео (фасад YouTube на карточке товара). */
  VIDEO_PLAY: 'video_play',
  /** 60% глубины скролла на длинной странице (EngagementTracking). */
  DEEP_SCROLL: 'deep_scroll',
  /** 60 секунд на сайте, раз за сессию (EngagementTracking). */
  ENGAGED_VISITOR: 'engaged_visitor',
} as const;

/**
 * Server-side цели (шлёт НЕ сайт, а модуль ботов через Measurement
 * Protocol / Offline Conversions API — см. recipes/lead-pipeline.md) — здесь
 * для полноты контракта с интерфейсом Метрики (тоже «JavaScript-событие»):
 *   lead_qualified / lead_target / lead_rejected — кнопки квалификации
 *   на карточке заявки в боте;
 *   lead_flushed — черновик ушёл менеджерам по таймауту (шаг 2 не заполнен).
 */

export type GoalId = (typeof GOALS)[keyof typeof GOALS];

declare global {
  interface Window {
    ym?: (id: number, method: string, ...args: unknown[]) => void;
    __ymId?: number;
  }
}

/** Fire a Metrika conversion goal. Safe to call before the counter loads. */
export function reachGoal(
  goal: GoalId | string,
  params?: Record<string, unknown>,
  callback?: () => void,
): void {
  if (typeof window === 'undefined' || !window.ym || !METRIKA_ID) {
    callback?.(); // аналитика недоступна — сценарий продолжается как обычно
    return;
  }
  try {
    // ВАЖНО: callback Метрики вызывается ПОСЛЕ фактической отправки цели.
    // Он обязателен везде, где сразу за целью идёт переход на другую страницу
    // или закрытие вкладки: иначе цель остаётся в очереди и умирает вместе с
    // выгружаемой страницей. Так на боевом проекте потерялись ВСЕ конверсии
    // отправки формы — в Метрике 0 достижений при живых заявках в базе.
    // Подробности: docs/ANALYTICS-PITFALLS.md, ошибка №1.
    if (params && Object.keys(params).length) {
      window.ym(METRIKA_ID, 'reachGoal', goal, params, callback);
    } else {
      window.ym(METRIKA_ID, 'reachGoal', goal, undefined, callback);
    }
  } catch {
    /* never let analytics break UX */
    callback?.();
  }
}
