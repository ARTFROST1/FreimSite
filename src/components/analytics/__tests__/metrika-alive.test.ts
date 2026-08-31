/**
 * Регрессия на баг 2026-08-11: тело <script is:inline>, обёрнутое в JSX-
 * выражение {`…`}, Astro выводит как текст — скобки и бэктики попадают в
 * браузер буквально, и код становится мёртвой строкой. Счётчик при этом
 * выглядит подключённым, но не инициализируется — молчаливая потеря всей
 * аналитики. Тест рендерит реальные компоненты и проверяет, что в script
 * лежит исполняемый код.
 */
import { describe, it, expect, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

// METRIKA_ID вычисляется при загрузке модуля analytics.ts, поэтому env
// подменяется до динамического импорта компонентов.
vi.stubEnv('PUBLIC_YANDEX_METRIKA_ID', '12345678');

/** Тело первого <script> в отрендеренном html. */
function scriptBody(html: string): string {
  const match = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
  expect(match, 'ожидался <script> в выводе компонента').not.toBeNull();
  return match![1]!;
}

describe('счётчик Метрики — исполняемый код, а не мёртвая строка', () => {
  it('YandexMetrika.astro инициализирует ym', async () => {
    const { default: YandexMetrika } = await import('../YandexMetrika.astro');
    const container = await AstroContainer.create();
    const html = await container.renderToString(YandexMetrika);
    const body = scriptBody(html);

    // Симптом бага: тело начинается с литеральных {` и кончается `}.
    expect(body).not.toMatch(/\{\s*`/);
    expect(body).not.toMatch(/`\s*\}/);
    // Живой код: вызов init присутствует как код, define:vars дал id.
    expect(body).toContain("ym(id, 'init'");
    expect(body).toContain('12345678');
  });

  it('consent-gate: до согласия tag.js не грузится, очередь ym создаётся', async () => {
    const { default: YandexMetrika } = await import('../YandexMetrika.astro');
    const container = await AstroContainer.create();
    const html = await container.renderToString(YandexMetrika);
    const body = scriptBody(html);

    // Очередь ym создаётся всегда (цели копятся до согласия).
    expect(body).toContain('window.ym = window.ym ||');
    // Гейт: загрузка tag.js ждёт события согласия из CookieConsent.
    expect(body).toContain('app:cookie-consent');
    expect(body).toContain("localStorage.getItem('cookie-consent')");
    // SPA-схема: defer:true — авто-хитов нет, все шлёт AnalyticsRouterHit.
    expect(body).toContain('defer: true');
    expect(body).toContain('webvisor: true');
  });

  it('AnalyticsRouterHit.astro шлёт hit кодом, не строкой', async () => {
    const { default: AnalyticsRouterHit } = await import('../AnalyticsRouterHit.astro');
    const container = await AstroContainer.create();
    const html = await container.renderToString(AnalyticsRouterHit);
    const body = scriptBody(html);

    expect(body).not.toMatch(/\{\s*`/);
    expect(body).not.toMatch(/`\s*\}/);
    expect(body).toContain("'hit'");
  });
});
