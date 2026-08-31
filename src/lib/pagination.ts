/**
 * Чистое ядро пагинации — без DOM и без Astro, чтобы покрывалось
 * unit-тестом (src/lib/__tests__/pagination.test.ts). Рендер —
 * `src/components/ui/Pagination.astro`; страницы блога —
 * `src/pages/blog/index.astro` + `src/pages/blog/page/[page].astro`.
 */

/** Элемент видимого окна номеров: номер страницы или многоточие. */
export type PageToken = number | 'ellipsis';

/**
 * Окно видимых номеров: первая и последняя страницы всегда, вокруг текущей —
 * ±`around` соседей, разрывы длиннее одной страницы схлопываются в
 * `'ellipsis'`. Разрыв ровно в одну страницу НЕ схлопывается — вместо
 * «1 … 3» показываем «1 2 3»: многоточие, скрывающее один номер, только
 * мешает.
 *
 * Аргументы вне диапазона зажимаются: `total < 1` → пустой список,
 * `current` — в [1, total].
 */
export function visiblePages(current: number, total: number, around = 2): PageToken[] {
  if (!Number.isFinite(total) || total < 1) return [];
  const last = Math.floor(total);
  const cur = Math.min(Math.max(Math.floor(current) || 1, 1), last);
  const span = Math.max(0, Math.floor(around));

  const wanted = new Set<number>([1, last]);
  for (let p = cur - span; p <= cur + span; p++) {
    if (p >= 1 && p <= last) wanted.add(p);
  }
  const sorted = [...wanted].sort((a, b) => a - b);

  const out: PageToken[] = [];
  let prev: number | undefined;
  for (const page of sorted) {
    if (prev !== undefined) {
      const gap = page - prev;
      if (gap === 2) out.push(prev + 1);
      else if (gap > 2) out.push('ellipsis');
    }
    out.push(page);
    prev = page;
  }
  return out;
}

export interface PageUrlOptions {
  /** Корневой URL списка, со слэшем на конце: `/blog/`. */
  base: string;
  /** Сегмент перед номером страницы: `/blog/<segment>/2/`. */
  segment?: string;
}

/**
 * URL страницы списка. Первая страница — это сам корень (`/blog/`), чтобы
 * существующий адрес не менялся и не дублировался как `/blog/page/1/`;
 * остальные — `/blog/page/N/`. Все адреса с завершающим слэшем
 * (`trailingSlash: 'always'` в astro.config.mjs).
 */
export function pageUrl(page: number, { base, segment = 'page' }: PageUrlOptions): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  return page <= 1 ? root : `${root}${segment}/${page}/`;
}

export interface PaginationLinks {
  first: string | null;
  previous: string | null;
  next: string | null;
  last: string | null;
}

/**
 * Ссылки «первая / назад / вперёд / последняя»: `null` там, где идти некуда
 * (на первой странице — first/previous, на последней — next/last). Компонент
 * рендерит `null` как неактивный `<span>`, а не ссылку на саму себя.
 */
export function paginationLinks(
  current: number,
  total: number,
  toHref: (page: number) => string,
): PaginationLinks {
  const last = Math.max(1, Math.floor(total));
  const cur = Math.min(Math.max(Math.floor(current) || 1, 1), last);
  return {
    first: cur > 1 ? toHref(1) : null,
    previous: cur > 1 ? toHref(cur - 1) : null,
    next: cur < last ? toHref(cur + 1) : null,
    last: cur < last ? toHref(last) : null,
  };
}

/** Подстановка `{current}`/`{total}`/`{n}` в строковые подписи компонента. */
export function formatPageLabel(
  template: string,
  values: { current?: number; total?: number; n?: number },
): string {
  return template.replace(/\{(current|total|n)\}/g, (_, key: keyof typeof values) =>
    String(values[key] ?? ''),
  );
}
