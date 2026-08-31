/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_YANDEX_METRIKA_ID?: string;
  /** '0'/'false' → tag.js Метрики грузится сразу, без ожидания согласия
   *  из CookieConsent (см. YandexMetrika.astro, consent-gate 152-ФЗ). */
  readonly PUBLIC_METRIKA_CONSENT_GATE?: string;
  readonly PUBLIC_CONTACT_ENDPOINT?: string;
  /** '1'/'true' → lead-form.ts skips the network call, warns loudly, and
   *  still redirects to /thanks/ — for client demos before the real lead
   *  backend is wired up. Leave unset in production. */
  readonly PUBLIC_LEAD_DEMO_MODE?: string;
  readonly PUBLIC_MAPS_API_KEY?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly TELEGRAM_CHAT_ID?: string;
  readonly FORMSPREE_ENDPOINT?: string;
  readonly INDEXNOW_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Runtime globals injected by third-party scripts. */
interface Window {
  /** Yandex Maps JS API (loaded lazily by YandexMap.astro). */
  ymaps?: any;
  /** Global goal dispatcher (defined by ConversionTracking.astro). */
  trackConversion?: (goal: string, params?: Record<string, unknown>) => void;

  /* `ym` и `__ymId` объявлены в lib/analytics.ts — там же, где обёртка
     reachGoal, которая их и вызывает. Дублировать здесь нельзя: TypeScript
     требует совпадения типов у повторных объявлений одного свойства. */

  /**
   * Флаги «инициализация уже прошла». Скрипты сайта живут под ClientRouter:
   * их модуль исполняется один раз, а init вызывается на каждый
   * `astro:page-load`, поэтому слушатели вешаются под защитой этих флагов.
   * Объявлены здесь, а не в каждом скрипте: бандл-скрипты проверяются
   * TypeScript'ом (в отличие от is:inline), и флагам нужен общий дом.
   */
  __convTrackInit?: boolean;
  __engageInit?: boolean;
  __videoEmbedInit?: boolean;
  __beforeAfterInit?: boolean;
  __modalInit?: boolean;
  __toastInit?: boolean;
  __carouselInit?: boolean;
  /** Живые инстансы Carousel.astro: cleanup отвалившихся узлов на page-load. */
  __carouselStore?: Map<HTMLElement, CarouselInstance>;
  __dropdownInit?: boolean;
  __tabsInit?: boolean;
  __tooltipInit?: boolean;

  /** Глобальный API уведомлений — ставит Toast.astro (см. его doc-комментарий). */
  toast?: ToastApi;
}

/** Инстанс карусели в `window.__carouselStore` (Carousel.astro). */
interface CarouselInstance {
  cleanup: () => void;
}

/* ── Toast.astro: window.toast ── */
type ToastType = 'success' | 'error' | 'info';

interface ToastOptions {
  type?: ToastType;
  duration?: number;
}

interface ToastApi {
  show(message: string, options?: ToastOptions): string;
  success(message: string, duration?: number): string;
  error(message: string, duration?: number): string;
  info(message: string, duration?: number): string;
  dismissAll(): void;
}
