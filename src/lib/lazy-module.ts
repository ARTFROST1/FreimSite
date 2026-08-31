/**
 * ============================================================================
 *  lazy-module.ts — генерик-хелперы ленивой загрузки тяжёлых модулей.
 * ----------------------------------------------------------------------------
 *  Портировано с боевого проекта, ConstructorSection.astro (строки 876-900,
 *  997-1027): секция подгружала GSAP + ScrollTrigger (116 КБ распакованных)
 *  динамическим `import()`, и только когда посетитель подошёл к секции на
 *  несколько экранов — на первом экране канал остаётся hero-картинке, а не
 *  библиотеке анимации, до которой доскроллит меньшинство.
 *
 *  Два независимых хелпера:
 *   - `loadOnce` — мемоизирует динамический импорт: повторный вызов отдаёт
 *     ТОТ ЖЕ промис, а не гоняет `import()` заново при каждом ре-маунте
 *     секции (смена брейкпоинта, SPA-навигация назад).
 *   - `whenNear` — IntersectionObserver-гейт «за N% экрана до элемента»:
 *     запас нужен, чтобы модуль успел распарситься и сцена — построиться ДО
 *     того, как элемент реально войдёт в экран, иначе первый кадр анимации
 *     дёргается.
 *
 *  GSAP НЕ добавлена в зависимости пакета — ниже только пример использования
 *  (см. оригинал на боевом проекте):
 *
 *    const loadGsap = loadOnce(async () => {
 *      const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
 *        import('gsap'),
 *        import('gsap/ScrollTrigger'),
 *      ]);
 *      gsap.registerPlugin(ScrollTrigger);
 *      return { gsap, ScrollTrigger };
 *    });
 *
 *    whenNear(document.getElementById('heavy-section'), async () => {
 *      const { gsap } = await loadGsap();
 *      // …построить сцену
 *    });
 * ============================================================================
 */

/**
 * Мемоизированный «однократный» загрузчик: первый вызов запускает `loader` и
 * запоминает промис, все последующие вызовы отдают ТОТ ЖЕ промис — в том
 * числе конкурентные вызовы до того, как первый settled (иначе гонка из двух
 * ре-маунтов подряд родила бы два параллельных `import()`).
 *
 * Ошибка НЕ кэшируется: после реджекта следующий вызов запускает `loader`
 * заново — временный сбой сети (или CDN) не должен блокировать секцию
 * анимацией до перезагрузки страницы.
 */
export function loadOnce<T>(loader: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = loader().catch((err: unknown) => {
        pending = null; // дать следующему вызову попробовать снова
        throw err;
      });
    }
    return pending;
  };
}

export interface WhenNearOptions {
  /**
   * Насколько заранее сработать — `rootMargin` для `IntersectionObserver`.
   * `'300% 0px'` (значение по умолчанию, как в ConstructorSection боевого проекта) —
   * запас больше, чем у внутреннего гейта самой сцены (там 250%), чтобы
   * тяжёлый модуль и построение сцены завершились ДО начала анимации.
   */
  rootMargin?: string;
  /**
   * `true` — вообще не наблюдать при `prefers-reduced-motion: reduce` (кейс
   * боевого проекта: reduced-motion строит статичный фолбэк и НИКОГДА не запрашивает
   * GSAP — см. doc-comment `initConstructor` в ConstructorSection.astro).
   * По умолчанию `false`: не всякий лениво загружаемый модуль анимационный
   * (например, отложенный чат-виджет грузится независимо от motion-настройки),
   * поэтому решение о reduced-motion остаётся за колбэком `cb`, а не
   * навязывается хелпером.
   */
  skipOnReducedMotion?: boolean;
}

/**
 * Вызывает `cb`, когда `el` подошёл к экрану на `rootMargin`. Без
 * `IntersectionObserver` (старый браузер) вызывает `cb` немедленно — лучше
 * лишний КБ раньше срока, чем секция без анимации вовсе.
 *
 * Возвращает функцию отмены наблюдения — вызвать её на
 * `astro:before-swap`/размонтировании секции, чтобы не словить `cb` после
 * того, как DOM, на который он опирается, уже исчез (тот же приём, что
 * `killConstructorScene` на боевом проекте). Наблюдение и так снимается само после первого
 * срабатывания — `cb` вызывается не более одного раза за вызов `whenNear`.
 */
export function whenNear(
  el: Element | null,
  cb: () => void,
  { rootMargin = '300% 0px', skipOnReducedMotion = false }: WhenNearOptions = {},
): () => void {
  if (!el) return () => {};

  if (skipOnReducedMotion && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return () => {};
  }

  if (!('IntersectionObserver' in window)) {
    cb();
    return () => {};
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      cb();
    },
    { rootMargin },
  );
  observer.observe(el);
  return () => observer.disconnect();
}
