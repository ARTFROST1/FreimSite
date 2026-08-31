import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(resolve(process.cwd(), 'public/fd-edit.js'), 'utf-8');
const PORTAL = 'https://portal.test';

/**
 * fd-edit.js — классический скрипт для браузера: активируется только в iframe
 * и только при известном origin портала. Поднимаем настоящий jsdom-документ,
 * подменяем `window.parent` (иначе скрипт выходит на первой строке) и
 * выполняем файл как есть — тест проверяет РЕАЛЬНЫЙ контракт сообщений, а не
 * его пересказ.
 */
function boot(bodyHtml: string) {
  const dom = new JSDOM(`<body>${bodyHtml}</body>`, {
    url: `https://site.test/?fd_edit=1&fd_origin=${encodeURIComponent(PORTAL)}`,
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  Object.defineProperty(win, 'parent', { value: { postMessage() {} }, configurable: true });
  win.eval(SRC);
  return dom;
}

function send(dom: JSDOM, message: unknown) {
  const { window } = dom;
  window.dispatchEvent(
    new window.MessageEvent('message', { data: message, origin: PORTAL }),
  );
}

const IMG = '<img id="slide" src="/_astro/a.hash.webp" data-cms="showcase:s1:image" data-fd-attr="src" />';

describe('fd-edit: патч src', () => {
  it('не подставляет ключ реестра в src (иначе картинка исчезнет из превью)', () => {
    const dom = boot(IMG);
    send(dom, { source: 'fd-portal', type: 'init', values: { showcase: [{ id: 's1', image: 'cms/a.png' }] } });
    expect(dom.window.document.getElementById('slide')!.getAttribute('src')).toBe('/_astro/a.hash.webp');
  });

  it('подставляет data:-URL живого превью загрузки', () => {
    const dom = boot(IMG);
    send(dom, {
      source: 'fd-portal',
      type: 'apply',
      path: { collection: 'showcase', itemId: 's1', field: 'image' },
      value: 'data:image/png;base64,AAAA',
    });
    expect(dom.window.document.getElementById('slide')!.getAttribute('src')).toBe(
      'data:image/png;base64,AAAA',
    );
  });

  it('подставляет публичный путь (легаси-значение и placeholder)', () => {
    const dom = boot(IMG);
    send(dom, {
      source: 'fd-portal',
      type: 'apply',
      path: { collection: 'showcase', itemId: 's1', field: 'image' },
      value: '/images/placeholder.svg',
    });
    expect(dom.window.document.getElementById('slide')!.getAttribute('src')).toBe(
      '/images/placeholder.svg',
    );
  });

  it('не ломает текстовые поля и href-шаблоны', () => {
    const dom = boot(
      '<span id="t" data-cms="hero::title">старый</span>' +
        '<a id="p" href="tel:+70000000000" data-cms="navigation::phone" data-fd-attr="href" data-fd-attr-template="tel:{value}">…</a>',
    );
    send(dom, {
      source: 'fd-portal',
      type: 'init',
      values: { hero: { title: 'новый' }, navigation: { phone: '+7 999' } },
    });
    expect(dom.window.document.getElementById('t')!.textContent).toBe('новый');
    expect(dom.window.document.getElementById('p')!.getAttribute('href')).toBe('tel:+7 999');
  });
});
