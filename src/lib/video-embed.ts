/**
 * video-embed — разбор ссылок на видеохостинги для фасада <VideoEmbed>
 * (src/components/ui/VideoEmbed.astro).
 *
 * Поддерживаемые формы URL:
 *   YouTube  youtube.com/watch?v=<id> | youtube.com/shorts/<id> |
 *            youtu.be/<id> | youtube(-nocookie).com/embed/<id>
 *            → https://www.youtube-nocookie.com/embed/<id>
 *   RuTube   rutube.ru/video/<hex32> | rutube.ru/shorts/<hex32> |
 *            rutube.ru/play/embed/<hex32>
 *            → https://rutube.ru/play/embed/<id>
 *   VK Video vkvideo.ru|vk.com/video<oid>_<id> (oid бывает отрицательным —
 *            это сообщества) → https://vkvideo.ru/video_ext.php?oid=&id=
 *
 * Идентификаторы валидируются жёсткими регулярками — из результата парсера
 * можно безопасно собирать URL для srcdoc. Всё остальное (включая не-http
 * схемы) → null. Тесты: src/lib/__tests__/video-embed.test.ts.
 */

export type VideoProvider = 'youtube' | 'rutube' | 'vk';

export interface ParsedVideo {
  provider: VideoProvider;
  /** Идентификатор ролика (у VK — `<oid>_<id>`). */
  id: string;
  /** URL плеера без автозапуска — фолбэк-`src` iframe'а. */
  embedUrl: string;
  /** Тот же плеер с autoplay=1 — ссылка кнопки play внутри srcdoc. */
  autoplayUrl: string;
  /** Автоматическое превью есть только у YouTube (i.ytimg.com). */
  posterUrl?: string;
  /** Вертикальный ролик (shorts) — дефолтный ratio фасада 9/16. */
  isShort: boolean;
}

/** id YouTube — 11 символов [A-Za-z0-9_-]; берём с запасом на будущее. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;

export function parseVideoUrl(raw: string | null | undefined): ParsedVideo | null {
  if (!raw) return null;

  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  const host = u.hostname.toLowerCase().replace(/^(?:www|m)\./, '');
  const path = u.pathname;

  // ---------------------------------------------------------------- YouTube
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    let id: string | null = null;
    let isShort = false;
    if (host === 'youtu.be') {
      id = path.split('/')[1] || null;
    } else if (path === '/watch') {
      id = u.searchParams.get('v');
    } else if (path.startsWith('/shorts/')) {
      id = path.split('/')[2] || null;
      isShort = true;
    } else if (path.startsWith('/embed/')) {
      id = path.split('/')[2] || null;
    }
    if (!id || !YOUTUBE_ID.test(id)) return null;
    const embedUrl = `https://www.youtube-nocookie.com/embed/${id}`;
    return {
      provider: 'youtube',
      id,
      embedUrl,
      autoplayUrl: `${embedUrl}?autoplay=1`,
      posterUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      isShort,
    };
  }

  // ----------------------------------------------------------------- RuTube
  if (host === 'rutube.ru') {
    const m = path.match(/^\/(video|shorts|play\/embed)\/([0-9a-f]{32})\/?$/i);
    if (!m) return null;
    const id = m[2].toLowerCase();
    const embedUrl = `https://rutube.ru/play/embed/${id}`;
    return {
      provider: 'rutube',
      id,
      embedUrl,
      autoplayUrl: `${embedUrl}?autoplay=1`,
      isShort: m[1] === 'shorts',
    };
  }

  // --------------------------------------------------------------- VK Video
  if (host === 'vkvideo.ru' || host === 'vk.com' || host === 'vk.ru') {
    const m = path.match(/^\/video(-?\d+)_(\d+)\/?$/);
    if (!m) return null;
    const [, oid, vid] = m;
    const embedUrl = `https://vkvideo.ru/video_ext.php?oid=${oid}&id=${vid}`;
    return {
      provider: 'vk',
      id: `${oid}_${vid}`,
      embedUrl,
      autoplayUrl: `${embedUrl}&autoplay=1`,
      isShort: false,
    };
  }

  return null;
}

/**
 * Экранирование строки для вставки в HTML srcdoc-фасада (текст и значения
 * атрибутов в двойных кавычках). Пользовательские title/poster проходят
 * через него ОБЯЗАТЕЛЬНО — сырые строки в srcdoc это та же stored-XSS,
 * что и запрещённый set:html.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
