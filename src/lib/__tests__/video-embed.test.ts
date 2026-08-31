import { describe, expect, it } from 'vitest';
import { escapeHtml, parseVideoUrl } from '../video-embed';

/**
 * parseVideoUrl питает srcdoc-фасад <VideoEmbed>: из результата парсера
 * строятся URL внутри iframe, поэтому фиксируем и все «человеческие» формы
 * ссылок, которые вставит заказчик, и мусор, обязанный давать null —
 * невалидированная строка в srcdoc это дыра, а не просто битый плеер.
 */
describe('parseVideoUrl — YouTube', () => {
  it('watch?v= → youtube-nocookie embed + автопревью', () => {
    const v = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(v).toMatchObject({
      provider: 'youtube',
      id: 'dQw4w9WgXcQ',
      embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      autoplayUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1',
      posterUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      isShort: false,
    });
  });

  it('переживает лишние query-параметры, mobile-хост и отсутствие www', () => {
    expect(parseVideoUrl('https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1')?.id).toBe(
      'dQw4w9WgXcQ',
    );
    expect(parseVideoUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')?.provider).toBe('youtube');
  });

  it('shorts → isShort (вертикальный фасад 9/16)', () => {
    const v = parseVideoUrl('https://www.youtube.com/shorts/AbC12_xyz-Q?feature=share');
    expect(v?.isShort).toBe(true);
    expect(v?.embedUrl).toBe('https://www.youtube-nocookie.com/embed/AbC12_xyz-Q');
  });

  it('youtu.be — короткая ссылка из «Поделиться»', () => {
    const v = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?si=share_tail&t=10');
    expect(v?.id).toBe('dQw4w9WgXcQ');
    expect(v?.isShort).toBe(false);
  });

  it('готовый embed-URL (обычный и nocookie) тоже понимает', () => {
    expect(parseVideoUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')?.id).toBe('dQw4w9WgXcQ');
    expect(parseVideoUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')?.id).toBe(
      'dQw4w9WgXcQ',
    );
  });
});

describe('parseVideoUrl — RuTube', () => {
  const id = '0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c';

  it('rutube.ru/video/<hex32> → play/embed', () => {
    const v = parseVideoUrl(`https://rutube.ru/video/${id}/`);
    expect(v).toMatchObject({
      provider: 'rutube',
      id,
      embedUrl: `https://rutube.ru/play/embed/${id}`,
      autoplayUrl: `https://rutube.ru/play/embed/${id}?autoplay=1`,
      isShort: false,
    });
    expect(v?.posterUrl).toBeUndefined(); // превью не угадать — нужен poster
  });

  it('без хвостового слэша и с готовым play/embed', () => {
    expect(parseVideoUrl(`https://rutube.ru/video/${id}`)?.id).toBe(id);
    expect(parseVideoUrl(`https://rutube.ru/play/embed/${id}`)?.id).toBe(id);
  });

  it('shorts → isShort', () => {
    expect(parseVideoUrl(`https://rutube.ru/shorts/${id}/`)?.isShort).toBe(true);
  });
});

describe('parseVideoUrl — VK Video', () => {
  it('vkvideo.ru/video<oid>_<id>, отрицательный oid сообщества', () => {
    const v = parseVideoUrl('https://vkvideo.ru/video-111222333_456789012');
    expect(v).toMatchObject({
      provider: 'vk',
      id: '-111222333_456789012',
      embedUrl: 'https://vkvideo.ru/video_ext.php?oid=-111222333&id=456789012',
      autoplayUrl: 'https://vkvideo.ru/video_ext.php?oid=-111222333&id=456789012&autoplay=1',
      isShort: false,
    });
    expect(v?.posterUrl).toBeUndefined();
  });

  it('vk.com и положительный oid (видео пользователя)', () => {
    const v = parseVideoUrl('https://vk.com/video123456_654321');
    expect(v?.embedUrl).toBe('https://vkvideo.ru/video_ext.php?oid=123456&id=654321');
  });
});

describe('parseVideoUrl — мусор обязан давать null', () => {
  it.each([
    ['пустая строка', ''],
    ['не URL', 'просто текст'],
    ['чужой хостинг', 'https://vimeo.com/123456789'],
    ['watch без v', 'https://www.youtube.com/watch'],
    ['битый id youtube', 'https://www.youtube.com/watch?v=<script>alert(1)</script>'],
    ['слишком короткий id youtube', 'https://youtu.be/ab'],
    ['канал, а не ролик', 'https://www.youtube.com/@somechannel'],
    ['rutube без hex32-id', 'https://rutube.ru/video/not-a-real-id/'],
    ['страница каналов rutube', 'https://rutube.ru/feeds/best/'],
    ['vk без пары oid_id', 'https://vk.com/videos-111222333'],
    ['профиль vk', 'https://vk.com/durov'],
    ['не-http схема', 'javascript:alert(1)'],
    ['поддельный домен-суффикс', 'https://youtu.be.evil.example.com/dQw4w9WgXcQ'],
  ])('%s', (_label, url) => {
    expect(parseVideoUrl(url)).toBeNull();
  });

  it('null/undefined безопасны', () => {
    expect(parseVideoUrl(null)).toBeNull();
    expect(parseVideoUrl(undefined)).toBeNull();
  });
});

describe('escapeHtml — заслон srcdoc от пользовательских строк', () => {
  it('экранирует всё значимое для HTML и атрибутов в кавычках', () => {
    expect(escapeHtml('<img src=x onerror="alert(\'xss\')"> & Ко')).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt; &amp; Ко',
    );
  });
});
