/**
 * ============================================================================
 *  UTM + client-id capture (ported from the catalogue reference implementation).
 * ----------------------------------------------------------------------------
 *  Every lead form automatically attaches the visitor's ad-attribution data:
 *  5 UTM params + yclid (Яндекс.Директ) + gclid (Google Ads), captured from
 *  the landing URL and persisted in sessionStorage across page navigations.
 *
 *  getClientId() returns a stable visitor id with a 3-tier fallback:
 *    1. Yandex Metrika `_ym_uid` cookie (matches ym getClientID, readable sync)
 *    2. Google Analytics `_ga` cookie
 *    3. First-party UUID persisted in localStorage
 *  So leads always carry *some* stable id even before analytics loads; once
 *  Metrika is live, tier 1 takes over and matches Metrika reports.
 *
 *  All functions are SSR-safe (no-op without `window`).
 * ============================================================================
 */

export interface UTMParams {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  yclid?: string;
  gclid?: string;
}

const UTM_KEYS: (keyof UTMParams)[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'yclid',
  'gclid',
];

const STORAGE_KEY = 'app_utm';
const CID_STORAGE_KEY = 'app_cid';

export function getUTMParams(url: URL): UTMParams {
  const params: UTMParams = {};
  for (const key of UTM_KEYS) {
    const value = url.searchParams.get(key);
    if (value) params[key] = value;
  }
  return params;
}

export function storeUTMParams(params: UTMParams): void {
  if (typeof window === 'undefined' || Object.keys(params).length === 0) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  } catch {
    /* private mode / quota */
  }
}

export function getStoredUTMParams(): UTMParams {
  if (typeof window === 'undefined') return {};
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as UTMParams) : {};
  } catch {
    return {};
  }
}

/** Capture UTM from the current URL and persist. Call once per page load. */
export function initUTMTracking(): void {
  if (typeof window === 'undefined') return;
  const params = getUTMParams(new URL(window.location.href));
  if (Object.keys(params).length > 0) storeUTMParams(params);
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(
    new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'),
  );
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** Best-effort stable visitor id (Metrika → GA → first-party UUID). */
export function getClientId(): string {
  if (typeof window === 'undefined') return '';

  const ym = readCookie('_ym_uid');
  if (ym) return ym;

  const ga = readCookie('_ga');
  if (ga) {
    const parts = ga.split('.');
    if (parts.length >= 4) return `${parts[2]}.${parts[3]}`;
  }

  try {
    let cid = localStorage.getItem(CID_STORAGE_KEY);
    if (!cid) {
      cid =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
      localStorage.setItem(CID_STORAGE_KEY, cid);
    }
    return cid;
  } catch {
    return '';
  }
}
