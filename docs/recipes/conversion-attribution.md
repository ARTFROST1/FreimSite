# Сквозная атрибуция: от клика по рекламе до офлайн-конверсии

Цель: каждая заявка знает, с какого объявления пришла, и каждый статус
(«дозвонились», «оплатил», «забронировал») возвращается в рекламный кабинет
для обучения стратегий. В стартере готова клиентская половина; серверная
описана по референсам эталона-витрины и эталона-каталога.

## Клиентская половина (в стартере)

### 1. Захват меток — `src/lib/utm.ts`
5 UTM + `yclid` (Директ) + `gclid` (Google Ads) читаются из URL при входе и
живут в `sessionStorage.app_utm` всю сессию. `UTMTracker.astro` в BaseLayout
делает это на каждой странице.

### 2. Стабильный client_id — `getClientId()`
Трёхуровневый каскад (ключ к сшиванию клиента между системами):
1. cookie `_ym_uid` — ровно то, что вернёт `ym getClientID`, но синхронно;
2. cookie `_ga` (если стоит GA);
3. first-party UUID в `localStorage.app_cid` — заявки несут стабильный id
   даже ДО подключения Метрики; после подключения каскад сам переключится
   на `_ym_uid` и id совпадёт с отчётами.

### 3. Цели — `ConversionTracking.astro`
`window.trackConversion(goal, params)` + два декларативных слоя: автодетект
по href (tel:/wa.me/t.me/vk/…) и `data-goal` атрибуты. Реестр целей —
`src/lib/analytics.ts` (`GOALS`).

### 4. Лид несёт всё с собой
`lead-form.ts` кладёт в тело заявки UTM + client_id + page_url. В Telegram
менеджер видит источник, в JSONL остаётся полная запись.

## Серверная половина (по референсам)

### Воронка статусов → Метрика (эталон-каталог)
Telegram-бот с кнопками статусов шлёт **Measurement Protocol**:
```
GET https://mc.yandex.ru/collect/?tid={counter}&cid={client_id}
    &t=event&ea={goal}&ms={MP_TOKEN}
```
`cid` — тот самый client_id из заявки. В Метрике появляются server-side цели
`lead_in_progress` / `lead_reached` / `lead_rejected` — Директ учится не на
«отправил форму», а на «реально дозвонились». Токен MP: Метрика → Настройки →
Загрузка данных.

### Атрибуция стороннего виджета (эталон-витрина)
Когда конверсия происходит в чужом виджете (бронирование RealtyCalendar),
прямой связки нет. Эталон-витрина решает через **ephemeral visitor store**:
1. На `/booking/` клиентский трекер снимает `ym getClientID` + UTM/yclid и
   POST-ит в `/api/store-visitor` (in-memory Map, TTL 30 минут).
2. Внешняя система шлёт webhook о брони → `/api/rc-webhook`.
3. Webhook берёт `findRecentVisitor(30min)` — последнего посетителя страницы
   бронирования — и шлёт Measurement Protocol `booking_complete` с его
   client_id и суммой брони. Плюс Telegram-уведомление. Токен удаляется
   (не выстрелит дважды). Webhook ВСЕГДА отвечает 200, чтобы источник не
   заретраил дубли.
Референс: `эталон-витрина/src/lib/visitor-store.ts` + `pages/api/rc-webhook.ts`.

### Офлайн-конверсии для Директа (эталон-витрина)
`/api/offline-conversions?format=csv` выгружает журнал конверсий в формате
Директа: `UserId,Target,DateTime,Price,Currency`, где UserId = yclid или
client_id. Файл загружается в Директ руками или по API.

### Бот-детекция (эталон-витрина, опционально)
`BotDetector.astro` скорит визит (webdriver=50, headless-рендерер WebGL=15,
нет плагинов/языков, ноль взаимодействий к 15-й секунде = 100). Score ≥ 70 →
цель `bot_detected` + лог в `/api/log-bot`. Зачем: чистить аудитории Директа
от скликивания. Референс: `эталон-витрина/src/components/analytics/BotDetector.astro`.

## Каркас целей (минимум для лидогена)

| Цель | Где стреляет |
| --- | --- |
| `lead_contact` {source} | lead-form.ts, шаг 1 двухшаговой формы пройден, черновик записан |
| `lead_submit` {source} | lead-form.ts, успех полной отправки |
| `lead_thankyou` {source} | /thanks/ |
| `popup_open` {source} | LeadPopup, открытие попапа |
| `phone_click` / `messenger_click` / `social_click` | автодетект по href |
| `cta_click` {source} | data-goal на кнопках |
| `gallery_view` {group} | Lightbox, полноэкранный просмотр фото |
| `video_play` | видео-фасад на карточке |
| `engaged_visitor`, `deep_scroll` | EngagementTracking |
| `lead_qualified/target/rejected`, `lead_flushed` | сервер (модуль ботов), OC API / MP |

Правило: цели создаются В Метрике руками (тип «JavaScript-событие», id =
имя цели). Не создана — reachGoal просто уходит в пустоту, без ошибок.

Актуальный полный реестр — `src/lib/analytics.ts` (`GOALS`); пошаговое
заведение целей в интерфейсе — [metrika-guide.md](metrika-guide.md).
