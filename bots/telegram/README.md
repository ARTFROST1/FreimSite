# Telegram-бот приёма лидов

Один процесс: локальный HTTP-приёмник лидов от сайта (`POST /notify` на
`127.0.0.1:8091`) + Telegram long polling. Форматирует лид в карточку
(единый формат с MAX-ботом), шлёт вложения (фото медиагруппой, прочее
документами) и карточку с кнопками квалификации **✅ Квал / 🔝 Целевой /
❌ Отказ** в рабочую группу. Статусы и авто-отправки уходят server-side
целями в Яндекс.Метрику: `lead_qualified`, `lead_target`, `lead_rejected`,
`lead_flushed`.

Обзор модуля, контракт `/notify` и полная таблица env — `../README.md`.

## Запуск локально

```bash
cd bots/telegram
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# .env рядом с bot.py НЕ нужен: переменные берутся из общего .env сайта
# (минимум для боевого запуска — TELEGRAM_BOT_TOKEN и TELEGRAM_GROUP_CHAT_ID).
.venv/bin/python bot.py
```

Без `TELEGRAM_BOT_TOKEN` бот мирно спит: процесс живёт, `/health` отвечает
`{"mode": "waiting_for_token"}`, `/notify` отдаёт 503 — незаполненный токен
не роняет деплой релиза.

## Как узнать GROUP_CHAT_ID

Добавить бота в рабочую группу и отправить там `/id` — бот ответит
`chat_id` чата. Вписать его в `TELEGRAM_GROUP_CHAT_ID` и перезапустить
сервис. Прочие команды: `/start`, `/ping`, `/help` (в `/help` — памятка
менеджеру по кнопкам).

## Контракт /notify

`POST http://127.0.0.1:8091/notify`, заголовок `X-Bot-Secret: <NOTIFY_SECRET>`,
тело — полный лид (формат — см. `../README.md`): `lead_id`,
`stage: complete|flushed|updated`, `phone`, `name`, `type`, `message`,
`contactMethod`, `prefill/case`, `source`, `client_id`, UTM, `yclid/gclid`,
`attachments[]` (`path` относительно `DATA_DIR`). Ответ `200 {"ok": true}` =
принято в фоновую доставку (ретраи 5 попыток, backoff 2/4/8/16 с).
Ошибки: `403 forbidden` (секрет), `503 group_not_configured`, `400 bad_json`.

Порядок в чате: сначала карточка с кнопками, затем вложения — ответами под
ней. `stage=updated` редактирует ранее отправленную карточку (реестр живёт
в памяти процесса; после рестарта придёт fallback-карточка «Дополнение к
заявке»).

`GET /health` — uptime, счётчики received/sent/failed, `pending_delivery`;
`?deep=1` дополнительно дёргает `getMe`.

## Деплой

Сервис-worker рядом с сайтом (пример для Freim Deploy: runtime `python`,
role `worker`, rootDir `bots/telegram`, run `.venv/bin/python bot.py`,
`requirements.txt` → авто pip+venv). Env — через панель, ключи — см.
`../README.md`; `DATA_DIR` должен совпадать с каталогом данных лидов сайта.
Порт 8091 фиксирован, слушает только `127.0.0.1` — наружу торчать не должен.
