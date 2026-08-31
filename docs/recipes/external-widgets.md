# Сторонние виджеты: бронирование, калькуляторы, CRM-формы

Референс: эталон-витрина + виджет бронирования HomeReserve/RealtyCalendar —
самый сложный случай интеграции в проде. Паттерны применимы к любому «чужому
JS в моей странице»: калькуляторы, квизы, онлайн-записи, чаты.

## 1. Unified loader — один загрузчик на сайт

Не инжектируйте виджет в каждой странице отдельно. Эталон-витрина держит ЕДИНЫЙ inline-
скрипт в BaseLayout, который на `astro:page-load` находит контейнер
(`#widget`) и инициализирует нужный режим по текущему pathname. Скелет:

```js
if (!window.__widgetInit) {
  window.__widgetInit = true;
  function initWidget() {
    var el = document.getElementById('widget');
    if (!el) return;                       // на этой странице виджета нет
    el.innerHTML = '';                     // сброс после SPA-навигации
    showLoader();
    if (tryInit()) return;                 // API уже загружен → реюз
    if (!document.querySelector('script[src="https://vendor/widget.js"]')) {
      var s = document.createElement('script');
      s.src = 'https://vendor/widget.js';
      s.onload = () => poll(tryInit);      // некоторые виджеты сначала
      s.onerror = showFallback;            // грузят скрипт, потом мутят DOM
      document.head.appendChild(s);
    } else poll(tryInit);                  // инжект уже в полёте
  }
  document.addEventListener('astro:page-load', initWidget);
}
```

Обязательные элементы UX (эталон-витрина делает все три):
- **Лоадер** — спиннер, пока виджет монтируется;
- **Поллинг с таймаутом** — `setInterval` 200 мс до 8 с:글обал появился →
  init; нет → фолбэк;
- **Фолбэк** — «Не удалось загрузить форму → [открыть на сайте вендора]»,
  прямая ссылка на hosted-страницу виджета. Пользователь никогда не
  упирается в пустой блок.

## 2. View Transitions ломают виджеты — чините стили

Виджеты инжектят свои `<style>`/`<link>` в `<head>`. При SPA-навигации Astro
собирает новый `<head>`, и стили виджета ПРОПАДАЮТ (виджет «голый» после
возврата на страницу). Решение эталона-витрины — переносить их вручную:

```js
document.addEventListener('astro:before-swap', (ev) => {
  const kept = new Set([...ev.newDocument.querySelectorAll('head style')]
    .map(s => (s.textContent || '').trim()));
  document.querySelectorAll('head style').forEach(style => {
    const txt = (style.textContent || '').trim();
    if (!txt || kept.has(txt)) return;
    if (txt.includes('[data-astro-')) return;      // стили Astro не трогаем
    ev.newDocument.head.appendChild(style.cloneNode(true));
  });
  // аналогично для <link rel="stylesheet">, дедуп по href
});
```

## 3. Рескин под бренд

Стили виджета перекрываются СКОУПЛЕННЫМ CSS с `!important`, всё под корневым
селектором виджета (`#widget .vendor-btn { ... !important }`) — ничего не
утекает на сайт. Эталон-витрина держит это отдельным файлом и подключает по
`prefers-color-scheme`. Если вендор позволяет вставить CSS в свой hosted-режим
(«произвольный код в head») — тот же файл работает и там.

## 4. Конверсии из чужого DOM

Виджет не шлёт ваши цели. Два детектора успеха (эталон-витрина использует оба):
1. **hashchange** — SPA-виджеты меняют hash (`#/status/{token}`) → regex,
   token = ключ дедупа в `sessionStorage`;
2. **MutationObserver** на контейнере — ловит появление `.success-container`
   (с ретраями: контейнер может смонтироваться позже).

Если виджет открывается на ДОМЕНЕ ВЕНДОРА (не iframe у вас), вставьте
зеркальный сниппет в настройках вендора: он re-init-ит вашу Метрику,
читает UTM из `window.parent.sessionStorage` (try/catch — кросс-домен),
детектит успех теми же приёмами и дублирует beacon на ваш API. Референс:
`эталон-витрина/scripts/rc-booking-analytics.js`.

## 5. Атрибуция вебхуком

Самый надёжный источник «конверсия случилась» — серверный webhook вендора,
а сшивание с посетителем — через visitor-store (30-мин TTL). Подробно —
[conversion-attribution.md](conversion-attribution.md).

## Чек-лист интеграции виджета
- [ ] Лоадер + таймаут + фолбэк-ссылка
- [ ] Реинициализация на `astro:page-load`, стили переживают `astro:before-swap`
- [ ] preconnect к домену вендора в `<head>` (`<link rel="preconnect">`)
- [ ] Цели: открытие, вовлечение (2+ клика внутри), успех (с дедупом по token)
- [ ] Рескин скоуплен под контейнер, ничего не течёт наружу
