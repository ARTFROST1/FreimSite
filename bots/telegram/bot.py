#!/usr/bin/env python3
"""
Telegram-бот приёма лидов с сайта (модуль astro-starter, порт с боевого проекта).

Что делает:
  1. Поднимает локальный HTTP-приёмник `POST /notify` — сайт (Astro node-adapter)
     шлёт сюда полный лид (телефон + параметры заявки + вложения + client_id + UTM +
     yclid/gclid + …, спека §2.2). Бот форматирует его в карточку (спека §3)
     и постит в группу: сначала вложения (фото/PDF), затем карточку с кнопками.
  2. Работает как обычный Telegram-бот (long polling) и отвечает на команды:
       /start  — приветствие
       /id     — показать chat_id текущего чата (нужно для настройки группы!)
       /ping   — проверка живости
       /help   — справка
  3. На каждой карточке — инлайн-кнопки квалификации (✅ Квал / 🔝 Целевой /
     ❌ Отказ). Нажатие подписывает статус, менеджера и время, а также шлёт
     server-side цель в Яндекс.Метрику (Measurement Protocol).
  4. Лид со stage=flushed (клиент оставил телефон, но не дошёл до «Отправить»)
     помечается «⏱ Авто-отправка…», и при доставке карточки бот сразу шлёт
     MP-цель lead_flushed.

Один процесс = и приёмник лидов, и бот. Ставится рядом с сайтом на том же VDS
(worker в Freim Deploy), слушает 127.0.0.1 — наружу торчать не должен.

Запуск:  python bot.py   (переменные берутся из .env рядом с файлом)
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
import signal
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from aiohttp import ClientSession, ClientTimeout, FormData, web

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest, TelegramUnauthorizedError
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    CallbackQuery,
    FSInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputMediaPhoto,
    Message,
)

# ─── Общий .env проекта (сайт + оба бота — ОДИН файл) ───────────────────────
# Отдельного окружения у ботов нет намеренно. В Freim Deploy переменные проекта
# и так достаются ВСЕМ сервисам, поэтому второй набор рядом с bot.py — это не
# удобство, а второе место, где те же значения (секрет, каталог данных, номер
# счётчика) однажды разъедутся. Файл живёт рядом с сайтом: `.env` в корне
# проекта, либо `website/.env`, если сайт лежит в подпапке репозитория.
#
# Реальное окружение ВСЕГДА главнее файла: load_dotenv без override=True не
# трогает уже заданные значения, поэтому на проде, где переменные приходят от
# systemd/панели, файла может не быть вовсе.
def _load_project_env() -> str:
    """Находит и грузит общий .env. Возвращает путь (или '' — не найден)."""
    try:
        from dotenv import load_dotenv
    except ImportError:  # зависимость не обязательна: systemd передаст env сам
        return ""

    explicit = os.getenv("SITE_ENV_FILE", "").strip()
    if explicit:
        # Явное указание побеждает поиск: нестандартная раскладка каталогов.
        if os.path.isfile(explicit):
            load_dotenv(explicit)
            return explicit
        return ""

    here = os.path.dirname(os.path.abspath(__file__))
    candidates: list[str] = []
    directory = here
    for _ in range(8):  # вверх до корня репозитория, но не дальше
        candidates.append(os.path.join(directory, ".env"))
        candidates.append(os.path.join(directory, "website", ".env"))
        if os.path.isdir(os.path.join(directory, ".git")):
            break  # выше корня репозитория не поднимаемся: там чужие .env
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent

    for path in candidates:
        if os.path.isfile(path):
            load_dotenv(path)
            return path
    return ""


PROJECT_ENV_FILE = _load_project_env()


# ─── Конфиг ──────────────────────────────────────────────────────────────────
def _env(*names: str, default: str = "") -> str:
    """Первое непустое значение из перечисленных ключей.

    Позволяет держать ОДИН общий набор переменных на весь проект (панель
    Freim Deploy раздаёт общие переменные всем сервисам): у ключей, которые у
    ботов обязаны различаться, есть префиксное имя — `TELEGRAM_NOTIFY_PORT`
    против `MAX_NOTIFY_PORT`. Безпрефиксное имя остаётся как фолбэк для
    посервисных наборов и локального .env.
    """
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return default


BOT_TOKEN = _env("TELEGRAM_BOT_TOKEN", "BOT_TOKEN")
GROUP_CHAT_ID = _env("TELEGRAM_GROUP_CHAT_ID", "GROUP_CHAT_ID")
# Общий секрет с сайтом. Имя сайта — LEAD_NOTIFY_SECRET; безпрефиксное
# NOTIFY_SECRET остаётся фолбэком для посервисных наборов панели.
NOTIFY_SECRET = _env("LEAD_NOTIFY_SECRET", "NOTIFY_SECRET")
NOTIFY_HOST = _env("NOTIFY_HOST", default="127.0.0.1")
NOTIFY_PORT = int(_env("TELEGRAM_NOTIFY_PORT", "NOTIFY_PORT", default="8091"))
# Общий с сайтом каталог данных: attachments/<lead_id>/N.ext лежат тут,
# бот на том же хосте и читает файлы напрямую (спека §2.2/§2.3).
# Тот же каталог, что у сайта: сайт кладёт вложения, бот их читает.
DATA_DIR = _env("LEAD_DATA_DIR", "DATA_DIR")

# ── Яндекс.Метрика (серверные конверсии воронки по статусам лида) ────────────
# Когда менеджер жмёт статус на карточке (Квал / Целевой / Отказ), бот шлёт
# цель в Метрику через Measurement Protocol, привязывая её к ClientID
# посетителя (client_id из карточки). Плюс lead_flushed при доставке карточки
# со stage=flushed. Пусто → отправка тихо пропускается. METRIKA_MP_TOKEN:
# Метрика → Настройки счётчика → Measurement Protocol → включить → токен.
# Тот же счётчик, что у сайта (PUBLIC_YANDEX_METRIKA_ID) — второго номера
# у проекта не бывает, а две переменные под одно число разъезжаются.
METRIKA_COUNTER_ID = _env("METRIKA_COUNTER_ID", "PUBLIC_YANDEX_METRIKA_ID")
METRIKA_MP_TOKEN = _env("METRIKA_MP_TOKEN")
# OAuth-токен для Offline Conversions API (scope metrika:offline_data или
# metrika:write; живёт 1 год). Задан → квал-кнопки идут офлайн-конверсиями
# (окно 21 день); пуст → фолбэк на Measurement Protocol (окно 12 часов).
METRIKA_OAUTH_TOKEN = _env("METRIKA_OAUTH_TOKEN")
# Europe/Moscow = UTC+3 круглый год (без переходов) — фиксированный офсет, чтобы
# не тянуть tz-базу.
TZ_OFFSET_HOURS = int(_env("TZ_OFFSET_HOURS", default="3"))

MSK = timezone(timedelta(hours=TZ_OFFSET_HOURS))

# Название проекта/бренда для заголовков карточек и текстов команд.
BRAND_NAME = _env("BRAND_NAME", default="Сайт")

log = logging.getLogger("lead-bot")
router = Router()

# ─── Состояние для /health и фоновой доставки ────────────────────────────────
STARTED_AT = time.time()
STATS: dict[str, object] = {
    "received": 0,
    "sent": 0,
    "failed": 0,
    "last_sent_at": None,
    "last_error": None,
}
# Ссылки на фоновые задачи доставки — чтобы их не собрал GC до завершения.
_bg_tasks: set[asyncio.Task] = set()

# Доставка карточки в группу переживает флапы сети до api.telegram.org
# (типичная беда РФ-хостинга): несколько попыток с паузами. *_TIMEOUT ниже —
# отдельный таймаут на ОДНУ попытку, чтобы зависший запрос не копился.
# ── Очередь недоставленных (outbox) ──────────────────────────────────────────
# 22.08.2026 в 05:10 заявка не ушла в группу: api.telegram.org не отвечал, пять
# попыток за две минуты сгорели, и лид пропал — спас только MAX-бот, куда та же
# заявка дошла. Сеть до Telegram с российского хостинга отваливается регулярно,
# поэтому «пять попыток и сдались» — не стратегия. Недоставленное ложится
# файлом в общий DATA_DIR и повторяется фоном: переживает и рестарт, и деплой.
OUTBOX_RETRY_SECONDS = int(_env("OUTBOX_RETRY_SECONDS", default="300"))
# Через сколько часов прекратить попытки, оставив файл на ручной разбор.
OUTBOX_GIVE_UP_HOURS = int(_env("OUTBOX_GIVE_UP_HOURS", default="24"))

# ── Watchdog сайта (по умолчанию ВЫКЛЮЧЕН) ──────────────────────────────────
# Алерты НИКОГДА не идут в группу заявок: там работают менеджеры, и служебные
# сообщения про деплои и моргания сети там только мешают. Чтобы включить,
# нужен ОТДЕЛЬНЫЙ чат — MONITOR_CHAT_ID: заведите служебную группу, добавьте
# туда этого же бота и пришлите там /id. Пусто → watchdog не запускается вовсе.
#
# Основной мониторинг снаружи — UptimeRobot по адресу /api/health/ (см.
# docs/recipes/monitoring.md): внешняя проверка заметит и то, чего этот
# watchdog увидеть не может — падение самого сервера вместе с ботом.
MONITOR_CHAT_ID = _env("MONITOR_CHAT_ID")
# Пусто = watchdog выключен: страница проекта ещё не задана или мониторится
# только UptimeRobot'ом извне.
HEALTH_URL = _env("HEALTH_URL", default="")
HEALTH_INTERVAL = int(_env("HEALTH_INTERVAL", default="300"))
# Сколько провалов подряд до алерта. При редеплое сайт недоступен доли секунды
# (systemd stop/start укладывается в одну секунду), так что два провала с
# интервалом в пять минут деплоем не объяснить — это уже настоящая авария.
HEALTH_FAILS_BEFORE_ALERT = int(_env("HEALTH_FAILS_BEFORE_ALERT", default="2"))
# Пауза после старта: сразу после деплоя сайт ещё может подниматься.
HEALTH_START_DELAY = int(_env("HEALTH_START_DELAY", default="120"))

# ── Синхронизация статусов с MAX-ботом ───────────────────────────────────────
# Одна и та же заявка приходит в оба чата. Если менеджер нажал «Отказ» в MAX,
# в Telegram карточка должна перестать выглядеть необработанной — иначе второй
# менеджер перезвонит тому же человеку. Боты живут на одном хосте и общаются
# по localhost: каждый шлёт соседу статус, сосед правит свою карточку.
# Пусто → синхронизация выключена, всё работает как раньше.
# Префиксное имя первым: в Freim Deploy общие переменные проекта достаются
# ОБОИМ ботам, и один PEER_STATUS_URL на двоих заставил бы каждого слать
# статус самому себе (та же грабля, что с NOTIFY_PORT).
# Порт соседа берём из ЕГО переменной, а не константой: в Freim Deploy общие
# переменные проекта достаются ВСЕМ сервисам, поэтому MAX_NOTIFY_PORT виден и
# здесь. Иначе смена порта в панели тихо расстроила бы синхронизацию — URL
# остался бы на прежнем числе, и статусы уходили бы в пустоту.
_PEER_NOTIFY_PORT = _env("MAX_NOTIFY_PORT", default="8092")
PEER_STATUS_URL = _env(
    "TELEGRAM_PEER_STATUS_URL",
    default=f"http://127.0.0.1:{_PEER_NOTIFY_PORT}/peer-status",
)

DELIVERY_ATTEMPTS = 5
DELIVERY_TIMEOUT = 15             # сек на одну попытку send_message
MEDIA_TIMEOUT = 60                # сек на одну отправку файла/медиагруппы (до 5 МБ)
DELIVERY_BACKOFF = [2, 4, 8, 16]  # паузы между попытками (для попыток 1..4)

# ─── Словари карточки (спека §3) ─────────────────────────────────────────────
def _env_json_dict(name: str, default: dict[str, str]) -> dict[str, str]:
    """JSON-объект из env-переменной. Некорректный JSON НЕ роняет бота:
    warning в лог и работа на дефолте."""
    raw = os.getenv(name, "").strip()
    if not raw:
        return dict(default)
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("ожидается JSON-объект")
        return {str(k): str(v) for k, v in parsed.items()}
    except (ValueError, TypeError) as exc:
        log.warning("%s: некорректный JSON (%s) — используется дефолт", name, exc)
        return dict(default)


# Значения type из формы сайта → человекочитаемые подписи. Неизвестное — как
# есть. Словарь у каждого проекта свой — задаётся env-переменной (JSON-объект),
# образец формата:
#   LEAD_TYPE_LABELS='{"repair": "Ремонт", "design": "Дизайн-проект"}'
TYPE_LABELS = _env_json_dict("LEAD_TYPE_LABELS", {})
CONTACT_LABELS = {"phone": "телефон", "messenger": "мессенджер"}
# Значения source из payload → подпись источника лида в карточке:
#   LEAD_SOURCE_LABELS='{"form": "форма на сайте", "popup": "попап"}'
SOURCE_LABELS = _env_json_dict(
    "LEAD_SOURCE_LABELS", {"form": "форма на сайте", "popup": "попап"}
)

# Домены сайта: у своих страниц в карточке показываем только путь (page_label).
# Задаётся env SITE_HOSTS (через запятую). Пустое значение безопасно:
# свои страницы просто показываются с доменом, как чужие.
SITE_HOSTS = {
    h.strip().removeprefix("www.").lower()
    for h in _env("SITE_HOSTS", default="").split(",")
    if h.strip()
}
if not SITE_HOSTS:
    log.warning("SITE_HOSTS не задан — ссылки страниц будут показаны URL-ом целиком")

# Вложения: сайт принимает ЛЮБОЙ тип (решение 2026-08-14), бот раскладывает
# их по способу отправки. sendPhoto — только форматы, которые Telegram
# гарантированно перекодирует; всё остальное (.heic с айфона, .docx, .zip…)
# уходит документом, то есть скачивается менеджером как есть. Если Telegram
# всё же отверг картинку — фолбэк на документ (см. _send_attachments).
PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
MEDIA_GROUP_LIMIT = 10  # лимит Telegram на sendMediaGroup


# ─── Форматирование ──────────────────────────────────────────────────────────
def esc(value: object) -> str:
    """HTML-экранирование для parse_mode=HTML."""
    return html.escape(str(value), quote=False)


def fmt_phone(raw: str) -> str:
    """+79001234567 → +7 (900) 123-45-67. Мусор возвращаем как есть."""
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 11 and digits[0] in "78":
        digits = digits[1:]
    if len(digits) == 10:
        return f"+7 ({digits[0:3]}) {digits[3:6]}-{digits[6:8]}-{digits[8:10]}"
    return raw or "—"


def e164(raw: str) -> str:
    """+79001234567 из любого ввода (для tel:-ссылки)."""
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 10:
        digits = "7" + digits
    if len(digits) == 11 and digits[0] == "8":
        digits = "7" + digits[1:]
    return "+" + digits if digits else ""


def _row(label: str, value: object) -> str | None:
    """Строка `label: value`, если значение непустое. Формат `label: value`
    парсится обратно кнопками квалификации (_extract_field) — не менять."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return f"{label}: {esc(text)}"


def page_label(raw: object) -> str:
    """URL страницы → путь без схемы и домена: `/catalog/item/slug/`.

    Домен в карточке не несёт информации (сайт один), зато делает строку
    длинной и превращает её в ссылку. Оставляем путь с якорем — этого хватает,
    чтобы понять, откуда пришла заявка. Тот же вид у MAX-бота, где голый URL
    вдобавок разворачивался в OG-превью на пол-экрана.
    """
    text = str(raw or "").strip()
    if not text:
        return ""
    try:
        parsed = urlparse(text)
    except ValueError:
        return text
    if not parsed.netloc:
        return text
    host = parsed.netloc.removeprefix("www.")
    tail = parsed.path or "/"
    if parsed.query:
        tail += f"?{parsed.query}"
    if parsed.fragment:
        tail += f"#{parsed.fragment}"
    return tail if host in SITE_HOSTS else f"{host}{tail}"


def _plural(n: int, one: str, few: str, many: str) -> str:
    """Русская форма множественного числа: 1 файл, 2 файла, 5 файлов."""
    n = abs(n) % 100
    if 12 <= n <= 14:
        return many
    n %= 10
    if n == 1:
        return one
    if 2 <= n <= 4:
        return few
    return many


def _parse_dt(raw: object) -> datetime:
    """ISO-строку → datetime в МСК; иначе сейчас."""
    if isinstance(raw, str) and raw:
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(MSK)
        except ValueError:
            pass
    return datetime.now(MSK)


def format_lead(data: dict, n_photos: int = 0, n_docs: int = 0, n_missing: int = 0) -> str:
    """Собирает HTML-карточку лида (спека §3, редизайн по фидбеку E2E
    2026-08-13: информация разбита на блоки, комментарий — цитатой, аналитика —
    сворачиваемой цитатой, чтобы карточка не сливалась в сплошной текст).

    stage: '' | 'complete' — обычная карточка «Новая заявка»;
    'flushed' — плюс строка «Авто-отправка…»; 'updated' — заголовок
    «Дополнение к заявке» (используется ТОЛЬКО для fallback-карточки, когда
    оригинал редактировать не удалось — обычный путь updated редактирует
    старую карточку текстом без stage, см. deliver_to_group).
    """
    stage = str(data.get("stage") or "")
    name = str(data.get("name") or "Клиент с сайта").strip() or "Клиент с сайта"
    phone_raw = str(data.get("phone") or "").strip()

    if stage == "updated":
        lines: list[str] = [f"📝 <b>Дополнение к заявке</b> — {esc(BRAND_NAME)}"]
    else:
        lines = [f"📩 <b>Новая заявка</b> — {esc(BRAND_NAME)}"]
    # Лид ушёл по таймауту флашера: телефон есть, детали клиент не заполнил.
    if stage == "flushed":
        lines.append(
            "⏱ <i>Авто-отправка: клиент оставил телефон и согласие, но не нажал «Отправить»</i>"
        )
    lines.append("")
    lines.append(f"👤 <b>{esc(name)}</b>")

    if phone_raw:
        tel = e164(phone_raw)
        pretty = fmt_phone(phone_raw)
        # tel:-ссылка кликабельна в мобильном Telegram; на десктопе покажет номер.
        lines.append(f'📞 <a href="tel:{esc(tel)}">{esc(pretty)}</a>')

    # ── Тип заявки · способ связи ───────────────────────────────────────────
    type_raw = str(data.get("type") or "").strip()
    contact_raw = str(data.get("contactMethod") or "").strip()
    parts: list[str] = []
    if type_raw:
        parts.append(f"Тип: {esc(TYPE_LABELS.get(type_raw, type_raw))}")
    if contact_raw:
        parts.append(f"Связь: {esc(CONTACT_LABELS.get(contact_raw, contact_raw))}")
    if parts:
        lines.append("📋 " + " · ".join(parts))

    # ── Прототип из галереи / кейса («по мотивам») ──────────────────────────
    case_val = str(data.get("case") or data.get("prefill") or "").strip()
    if case_val:
        lines.append(f"🎯 По мотивам: {esc(case_val)}")

    # ── Комментарий клиента — отдельным блоком-цитатой ──────────────────────
    message = str(data.get("message") or "").strip()
    if message:
        lines.append("")
        lines.append("💬 <b>Комментарий</b>")
        lines.append(f"<blockquote>{esc(message)}</blockquote>")

    # ── Вложения (файлы уходят ответами ПОД карточкой — deliver_to_group) ───
    n_files = n_photos + n_docs
    if n_files or n_missing:
        lines.append("")
    if n_files:
        lines.append(
            f"📎 <b>{n_files} {_plural(n_files, 'файл', 'файла', 'файлов')}</b> — в ответах под карточкой"
        )
    if n_missing:
        lines.append(
            "📎 файл недоступен" if n_missing == 1 else f"📎 файлы недоступны ({n_missing})"
        )

    # ── Аналитика / метки — сворачиваемой цитатой (детали по клику) ─────────
    analytics = [
        _row("client_id", data.get("client_id")),
        _row("source", data.get("utm_source")),
        _row("medium", data.get("utm_medium")),
        _row("campaign", data.get("utm_campaign")),
        _row("term", data.get("utm_term")),
        _row("content", data.get("utm_content")),
        _row("yclid", data.get("yclid")),
        _row("gclid", data.get("gclid")),
        _row("Страница", page_label(data.get("page_url"))),
    ]
    analytics = [row for row in analytics if row]
    if analytics:
        lines.append("")
        lines.append("📊 <b>Аналитика</b>")
        lines.append("<blockquote expandable>" + "\n".join(analytics) + "</blockquote>")

    # ── Время (МСК) и источник лида ─────────────────────────────────────────
    dt = _parse_dt(data.get("completed_at") or data.get("created_at"))
    stamp = f"🕒 {dt.strftime('%d.%m.%Y %H:%M')} (МСК)"
    source_raw = str(data.get("source") or "").strip()
    source_label = SOURCE_LABELS.get(source_raw, source_raw)
    if source_label:
        stamp += f" · источник: {esc(source_label)}"
    lines.append("")
    lines.append(stamp)

    return "\n".join(lines)


# ─── Вложения ────────────────────────────────────────────────────────────────
# Файл к отправке: путь на диске + ИСХОДНОЕ имя от клиента (на диске лежит
# обезличенное «2.pdf», менеджеру нужно «смета-кухня.pdf»).
Attachment = tuple[Path, str]


def resolve_attachments(payload: dict) -> tuple[list[Attachment], list[Attachment], int]:
    """attachments[] (относительно DATA_DIR) → локальные файлы для отправки.

    Возвращает (фото, документы, число недоступных). Тип файла НЕ фильтруем
    (решение 2026-08-14): всё, что не гарантированно перекодируется Telegram
    в фото, уходит документом. Нечитаемый или чужой путь — warning и пропуск:
    карточка уйдёт в любом случае, с пометкой «файл недоступен» в тексте.
    """
    raw = payload.get("attachments")
    if not isinstance(raw, list) or not raw:
        return [], [], 0
    if not DATA_DIR:
        log.warning("Пришли вложения (%d шт.), но DATA_DIR не задан — файлы пропущены", len(raw))
        return [], [], len(raw)

    base = Path(DATA_DIR).resolve()
    photos: list[Attachment] = []
    docs: list[Attachment] = []
    missing = 0
    for att in raw:
        rel = str(att.get("path") or "").strip() if isinstance(att, dict) else ""
        path = (base / rel).resolve() if rel else None
        # Путь обязан оставаться внутри DATA_DIR (защита от ../-обхода).
        if path is None or not path.is_relative_to(base):
            log.warning("Вложение с подозрительным путём пропущено: %r", rel)
            missing += 1
            continue
        if not path.is_file():
            log.warning("Файл вложения не читается, пропускаем: %s", path)
            missing += 1
            continue
        # Исходное имя от клиента — только для подписи в Telegram, в путь оно
        # не попадает; basename на случай «C:\Users\…\фото.jpg» из Windows.
        raw_name = str(att.get("name") or "").strip() if isinstance(att, dict) else ""
        name = os.path.basename(raw_name.replace("\\", "/")) or path.name
        if path.suffix.lower() in PHOTO_EXTS:
            photos.append((path, name))
        else:
            docs.append((path, name))
    return photos, docs, missing


async def _send_documents(
    bot: Bot,
    chat_id: object,
    docs: list[Attachment],
    reply_to: int | None = None,
) -> None:
    """Документы по одному, с исходным именем файла (FSInputFile filename)."""
    for path, name in docs:
        try:
            await asyncio.wait_for(
                bot.send_document(
                    chat_id, FSInputFile(path, filename=name), reply_to_message_id=reply_to
                ),
                timeout=MEDIA_TIMEOUT,
            )
        except OSError as exc:
            log.warning("Документ %s не отправлен (файл не читается): %s", path, exc)


async def _send_attachments(
    bot: Bot,
    chat_id: object,
    photos: list[Attachment],
    docs: list[Attachment],
    reply_to: int | None = None,
) -> None:
    """Шлёт вложения ОТВЕТАМИ под карточкой (reply_to = message_id карточки —
    файлы визуально привязаны к своему лиду, чат не превращается в кашу из
    ничьих фотографий; фидбек E2E 2026-08-13). Фото — sendPhoto/sendMediaGroup,
    остальное — sendDocument с исходным именем.

    Telegram отверг картинку (битый файл, экзотический профиль JPEG, слишком
    большой пиксельный размер)? Не теряем её: перекладываем в документы —
    менеджер скачает файл как есть. OSError по файлу (исчез между проверкой и
    отправкой) глотается с warning; сетевые ошибки пробрасываются наверх — их
    разруливает retry-цикл.
    """
    fallback: list[Attachment] = []
    try:
        if len(photos) == 1:
            path, name = photos[0]
            await asyncio.wait_for(
                bot.send_photo(
                    chat_id, FSInputFile(path, filename=name), reply_to_message_id=reply_to
                ),
                timeout=MEDIA_TIMEOUT,
            )
        elif photos:
            media = [
                InputMediaPhoto(media=FSInputFile(p, filename=n))
                for p, n in photos[:MEDIA_GROUP_LIMIT]
            ]
            await asyncio.wait_for(
                bot.send_media_group(chat_id, media, reply_to_message_id=reply_to),
                timeout=MEDIA_TIMEOUT,
            )
    except OSError as exc:
        log.warning("Фото не отправлены (файл не читается): %s", exc)
    except TelegramBadRequest as exc:
        log.warning("Telegram отверг фото (%s) — шлём их документами", exc)
        fallback = list(photos)

    await _send_documents(bot, chat_id, [*fallback, *docs], reply_to)


# ─── Инлайн-кнопки квалификации ──────────────────────────────────────────────
# Подписи в футере карточки после нажатия. Перещёлкивание статуса разрешено —
# кнопки остаются, футер перезаписывается (как в эталоне-каталоге).
STATUS_LABELS = {
    "qual": "✅ Квалифицирован",
    "target": "🔝 Целевой квал",
    "reject": "❌ Отказ",
}
FOOTER_SEP = "———"


# ─── Серверные конверсии воронки (Яндекс.Метрика) ────────────────────────────
# Нажатый статус на карточке → цель в Метрике, привязанная к ClientID посетителя.
# Идентификаторы завести в интерфейсе Метрики как «JavaScript-событие» один-в-один
# (спека §6): lead_qualified / lead_target / lead_rejected / lead_flushed.
#
# ДВА КАНАЛА (решение 2026-08-12, разбор в docs/project/metrika-guide.md §MP-vs-offline):
#   • Квал-кнопки → Offline Conversions API (окно привязки 21 день: менеджер
#     квалифицирует лид через часы и дни, а Measurement Protocol события
#     позже 12 часов после визита МОЛЧА отбрасывает). Требует METRIKA_OAUTH_TOKEN
#     (scope metrika:offline_data). Колонка Target = тот же строковый
#     идентификатор JS-цели, отдельные «офлайн-цели» не нужны.
#   • lead_flushed → Measurement Protocol (стреляет через 15 минут после
#     визита — всегда в 12-часовом окне, зато мгновенно и без OAuth).
#   • Фолбэк: OAuth-токен не задан → кнопки идут через MP (конверсии того же
#     дня доедут, поздние потеряются — лучше, чем ничего).
STAGE_GOALS = {
    "qual": "lead_qualified",   # «✅ Квал» — квалифицированный лид
    "target": "lead_target",    # «🔝 Целевой» — целевой квал (ключевая цель для Директа)
    "reject": "lead_rejected",  # «❌ Отказ» (для воронки/аналитики, не для оптимизации)
}

# ClientID Метрики (_ym_uid) — строка цифр; иначе серверную цель не привязать.
_METRIKA_CID_RE = re.compile(r"^\d{8,}$")
# Дедуп в рамках аптайма процесса: (chat_id, message_id, goal). Повторное нажатие
# той же кнопки не задваивает цель. При рестарте бота множество сбрасывается.
_sent_conversions: set[tuple[int, int, str]] = set()
# Дедуп lead_flushed по lead_id (повторный notify того же лида не задваивает цель).
_flushed_sent: set[str] = set()


def _extract_field(text: str, label: str) -> str:
    """Значение строки `• label: value` из текста карточки (или '')."""
    m = re.search(re.escape(label) + r":\s*(\S+)", text or "")
    return m.group(1).strip() if m else ""


async def _offline_upload(goal: str, cid: str) -> bool:
    """Одна конверсия через Offline Conversions API. True = загрузка принята.

    CSV из одной строки: ClientId,Target,DateTime (unix-секунды, момент
    нажатия кнопки). Метрика привяжет конверсию к последнему визиту этого
    ClientID в окне 21 день до момента обработки файла; в отчётах — до 2 ч.
    """
    if not METRIKA_COUNTER_ID or not METRIKA_OAUTH_TOKEN:
        return False
    csv_body = f"ClientId,Target,DateTime\n{cid},{goal},{int(time.time())}\n"
    url = (
        "https://api-metrika.yandex.net/management/v1/counter/"
        f"{METRIKA_COUNTER_ID}/offline_conversions/upload"
    )
    form = FormData()
    form.add_field("file", csv_body, filename="conversions.csv", content_type="text/csv")
    try:
        async with ClientSession(timeout=ClientTimeout(total=10)) as session:
            async with session.post(
                url,
                params={"comment": f"leadbot {goal}"},
                headers={"Authorization": f"OAuth {METRIKA_OAUTH_TOKEN}"},
                data=form,
            ) as resp:
                if resp.status == 200:
                    body = await resp.json()
                    upload_id = (body.get("uploading") or {}).get("id")
                    log.info(
                        "Офлайн-конверсия %s загружена (cid=%s, uploading_id=%s)",
                        goal, cid, upload_id,
                    )
                    return True
                text = await resp.text()
                log.warning("Офлайн-конверсия %s: HTTP %s %s", goal, resp.status, text[:200])
    except Exception as exc:
        log.warning("Не удалось загрузить офлайн-конверсию %s: %s", goal, exc)
    return False


async def _mp_collect(goal: str, cid: str, yclid: str = "") -> bool:
    """Одна цель Measurement Protocol → mc.yandex.ru/collect. True = принято.
    Метрика не настроена (пустые env) → тихий скип."""
    if not METRIKA_COUNTER_ID or not METRIKA_MP_TOKEN:
        return False
    params = {
        "tid": METRIKA_COUNTER_ID,
        "cid": cid,
        "t": "event",
        "ea": goal,
        "ms": METRIKA_MP_TOKEN,
    }
    if yclid:
        params["yclid"] = yclid
    try:
        async with ClientSession(timeout=ClientTimeout(total=5)) as session:
            async with session.get("https://mc.yandex.ru/collect/", params=params) as resp:
                if resp.status == 200:
                    log.info("Конверсия %s → Метрика (cid=%s)", goal, cid)
                    return True
                body = await resp.text()
                log.warning("Метрика collect %s: HTTP %s %s", goal, resp.status, body[:200])
    except Exception as exc:
        log.warning("Не удалось отправить конверсию %s: %s", goal, exc)
    return False


async def send_stage_conversion(cb: CallbackQuery, key: str) -> None:
    """Отправляет цель воронки в Метрику по нажатому статусу. Fire-and-forget.

    Основной канал — Offline Conversions (окно 21 день, квалификация может
    случиться через дни после визита); без OAuth-токена — фолбэк на MP.
    """
    goal = STAGE_GOALS.get(key)
    if not goal or not METRIKA_COUNTER_ID or cb.message is None:
        return

    dedup_key = (cb.message.chat.id, cb.message.message_id, goal)
    if dedup_key in _sent_conversions:
        return

    text = cb.message.text or cb.message.html_text or ""
    cid = _extract_field(text, "client_id")
    if not _METRIKA_CID_RE.match(cid):
        log.info("Конверсия %s пропущена: в карточке нет валидного client_id", goal)
        return

    ok = (
        await _offline_upload(goal, cid)
        if METRIKA_OAUTH_TOKEN
        else await _mp_collect(goal, cid, _extract_field(text, "yclid"))
    )
    if ok:
        _sent_conversions.add(dedup_key)


async def send_flushed_conversion(payload: dict) -> None:
    """MP-цель lead_flushed сразу при доставке карточки со stage=flushed:
    фиксируем в воронке «лид ушёл по таймауту» (спека §3/§6)."""
    if not METRIKA_COUNTER_ID or not METRIKA_MP_TOKEN:
        return
    lead_id = str(payload.get("lead_id") or "")
    if lead_id and lead_id in _flushed_sent:
        return
    cid = str(payload.get("client_id") or "").strip()
    if not _METRIKA_CID_RE.match(cid):
        log.info("lead_flushed пропущена: нет валидного client_id (lead_id=%s)", lead_id)
        return
    if await _mp_collect("lead_flushed", cid, str(payload.get("yclid") or "").strip()):
        if lead_id:
            _flushed_sent.add(lead_id)


def qual_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="✅ Квал", callback_data="lead:qual"),
                InlineKeyboardButton(text="🔝 Целевой", callback_data="lead:target"),
                InlineKeyboardButton(text="❌ Отказ", callback_data="lead:reject"),
            ]
        ]
    )


@router.callback_query(F.data.startswith("lead:"))
async def on_status(cb: CallbackQuery) -> None:
    key = cb.data.split(":", 1)[1]
    label = STATUS_LABELS.get(key, key)
    user = cb.from_user.full_name if cb.from_user else "менеджер"
    now = datetime.now(MSK).strftime("%d.%m %H:%M")

    base = ""
    if cb.message is not None:
        base = cb.message.html_text or cb.message.text or ""
    # Срезаем прошлый футер статуса, если кнопку жмут повторно.
    idx = base.find(FOOTER_SEP)
    if idx != -1:
        base = base[:idx].rstrip()

    footer = f"\n\n{FOOTER_SEP}\n<b>{esc(label)}</b> · {esc(user)} · {now}"
    try:
        if cb.message is not None:
            await cb.message.edit_text(base + footer, reply_markup=qual_kb())
    except Exception as exc:  # сообщение слишком старое / не изменилось и т.п.
        log.warning("edit_text failed: %s", exc)
    await cb.answer(label)

    # Серверная конверсия воронки в Метрику (по ClientID из карточки).
    await send_stage_conversion(cb, key)

    # И сообщаем соседнему боту: та же заявка лежит и у него, там карточка
    # должна перестать выглядеть необработанной.
    if cb.message is not None:
        lead_id = _lead_by_card(cb.message.chat.id, cb.message.message_id)
        if lead_id:
            await notify_peer_status(lead_id, label, user)


# ─── Синхронизация статуса с соседним ботом ──────────────────────────────────
async def notify_peer_status(lead_id: str, label: str, by: str) -> None:
    """Сообщить MAX-боту, что по заявке нажали статус. Fire-and-forget.

    Сознательно без ретраев: это удобство (не дать второму менеджеру звонить
    по уже закрытой заявке), а не доставка лида. Упало — статус всё равно
    виден в том чате, где нажали.
    """
    if not PEER_STATUS_URL or not lead_id:
        return
    payload = {
        "lead_id": lead_id,
        "label": label,
        "by": by,
        "at": datetime.now(MSK).strftime("%d.%m %H:%M"),
        "from": "Telegram",
    }
    headers = {"Content-Type": "application/json"}
    if NOTIFY_SECRET:
        headers["X-Bot-Secret"] = NOTIFY_SECRET
    try:
        timeout = ClientTimeout(total=5)
        async with ClientSession(timeout=timeout) as session:
            async with session.post(PEER_STATUS_URL, json=payload, headers=headers) as resp:
                if resp.status >= 400:
                    log.warning("Статус соседу не принят: HTTP %s", resp.status)
                else:
                    log.info("Статус «%s» отправлен соседнему боту (lead_id=%s)", label, lead_id)
    except Exception as exc:
        log.warning("Не удалось сообщить статус соседнему боту: %s: %s",
                    type(exc).__name__, exc or "—")


async def handle_peer_status(request: web.Request) -> web.Response:
    """MAX-бот сообщил, что по заявке нажали статус — правим свою карточку."""
    if NOTIFY_SECRET and request.headers.get("X-Bot-Secret") != NOTIFY_SECRET:
        return web.json_response({"ok": False, "error": "forbidden"}, status=403)
    bot: Bot | None = request.app.get("bot")
    if bot is None:
        return web.json_response({"ok": False, "error": "no_token"}, status=503)
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad_json"}, status=400)

    lead_id = str(data.get("lead_id") or "")
    label = str(data.get("label") or "").strip()
    by = str(data.get("by") or "менеджер").strip()
    at = str(data.get("at") or datetime.now(MSK).strftime("%d.%m %H:%M"))
    source = str(data.get("from") or "MAX")
    card = _lead_cards.get(lead_id)
    if not lead_id or not label:
        return web.json_response({"ok": False, "error": "bad_request"}, status=400)
    if not card:
        # Карточки нет: бот перезапускался (реестр в памяти) или заявка пришла
        # только в MAX. Это не ошибка — просто нечего править.
        log.info("Статус от соседа: карточка не найдена (lead_id=%s)", lead_id)
        return web.json_response({"ok": True, "updated": False})

    chat_id, message_id = card
    # Отвечаем реплаем под карточкой, а не правим её текст: исходный текст в
    # памяти не храним, а собирать его заново из payload — лишняя связность.
    # Реплай виден там же, в ветке карточки, и не может её испортить.
    try:
        await bot.send_message(
            chat_id,
            f"{esc(label)} · {esc(by)} · {at} · из {esc(source)}",
            reply_to_message_id=message_id,
            disable_web_page_preview=True,
        )
        log.info("Статус «%s» из %s отражён в Telegram (lead_id=%s)", label, source, lead_id)
        return web.json_response({"ok": True, "updated": True})
    except Exception as exc:
        log.warning("Не удалось отразить статус соседа: %s: %s", type(exc).__name__, exc or "—")
        return web.json_response({"ok": False, "error": "edit_failed"}, status=500)


# ─── Команды ─────────────────────────────────────────────────────────────────
@router.message(CommandStart())
async def cmd_start(m: Message) -> None:
    await m.answer(
        f"👋 Я бот приёма заявок — {esc(BRAND_NAME)}.\n\n"
        "Добавьте меня в рабочую группу и отправьте там <b>/id</b>, чтобы узнать "
        "её <code>chat_id</code> — его нужно вписать в конфиг бота.\n\n"
        "Команды: /id · /ping · /help"
    )


@router.message(Command("id"))
async def cmd_id(m: Message) -> None:
    await m.reply(
        f"chat_id: <code>{m.chat.id}</code>\n"
        f"тип чата: <b>{m.chat.type}</b>\n\n"
        "Впишите это значение в <code>GROUP_CHAT_ID</code> в env бота "
        "и перезапустите сервис."
    )


@router.message(Command("ping"))
async def cmd_ping(m: Message) -> None:
    await m.reply("pong ✅")


# Памятка по кнопкам — общий текст для /help и для закрепа в группе
# (docs/recipes/manager-guide.md). Держать синхронно с ним.
BUTTONS_GUIDE = (
    "<b>Что жать после разговора с клиентом</b>\n\n"
    "✅ <b>Квал</b> — человек реально заинтересован в услуге/товаре: "
    "обсуждаем детали, сроки.\n"
    "🔝 <b>Целевой</b> — то же, но клиент готов к следующему шагу "
    "(замер/предоплата/договор).\n"
    "❌ <b>Отказ</b> — спам, ошибка, не наш профиль запроса.\n\n"
    "Жмите <b>одну</b> кнопку на карточку, лучше сразу после звонка. "
    "Передумали — нажмите другую, статус перезапишется. "
    "Без нажатия реклама не понимает, какие заявки приносят продажи, "
    "и хуже ищет похожих клиентов."
)


@router.message(Command("help"))
async def cmd_help(m: Message) -> None:
    await m.reply(
        f"Я принимаю заявки с сайта {esc(BRAND_NAME)} и публикую их сюда "
        "(файлы клиента — ответами под карточкой).\n\n"
        f"{BUTTONS_GUIDE}\n\n"
        "<b>/id</b> — chat_id этого чата (для настройки) · <b>/ping</b> — проверка связи"
    )


# ─── Очередь недоставленных заявок ───────────────────────────────────────────
def _outbox_dir() -> Path | None:
    """Каталог очереди. Без DATA_DIR очередь недоступна — работаем как раньше."""
    if not DATA_DIR:
        return None
    d = Path(DATA_DIR) / "outbox" / "telegram"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        log.error("Не удалось создать каталог очереди %s: %s", d, exc)
        return None
    return d


def outbox_put(payload: dict) -> None:
    """Отложить недоставленную заявку. Имя файла — lead_id, повтор перезапишет."""
    d = _outbox_dir()
    lead_id = str(payload.get("lead_id") or "")
    if d is None or not lead_id:
        log.error(
            "Заявка не доставлена и НЕ отложена в очередь (lead_id=%s, DATA_DIR=%r) — "
            "разбирайте по логам", lead_id, DATA_DIR,
        )
        return
    record = {"queued_at": datetime.now(timezone.utc).isoformat(), "payload": payload}
    try:
        tmp = d / f"{lead_id}.json.tmp"
        tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        tmp.replace(d / f"{lead_id}.json")
        log.warning("Заявка отложена в очередь повторов (lead_id=%s)", lead_id)
    except Exception as exc:
        log.error("Не удалось отложить заявку (lead_id=%s): %s", lead_id, exc)


def outbox_drop(lead_id: str) -> None:
    """Убрать из очереди — заявка доставлена."""
    d = _outbox_dir()
    if d is None or not lead_id:
        return
    try:
        (d / f"{lead_id}.json").unlink(missing_ok=True)
    except Exception as exc:
        log.warning("Не удалось убрать из очереди (lead_id=%s): %s", lead_id, exc)


def outbox_pending() -> int:
    """Сколько заявок ждёт повтора — уходит в /health."""
    d = _outbox_dir()
    if d is None:
        return 0
    try:
        return len(list(d.glob("*.json")))
    except Exception:
        return 0


async def outbox_retry_loop(bot: Bot, chat_id: str) -> None:
    """Фоновый повтор недоставленных заявок.

    Интервал больше, чем у ретраев внутри доставки: если сеть до Telegram
    отвалилась, ей нужны минуты, а не секунды. Файл лежит до победы или до
    OUTBOX_GIVE_UP_HOURS — после этого переименовывается в .stale и остаётся
    для ручного разбора, чтобы мёртвая заявка не занимала очередь вечно.
    """
    while True:
        await asyncio.sleep(OUTBOX_RETRY_SECONDS)
        d = _outbox_dir()
        if d is None:
            continue
        try:
            files = sorted(d.glob("*.json"))
        except Exception as exc:
            log.error("Очередь недоступна: %s", exc)
            continue
        if not files:
            continue
        log.info("Очередь повторов: %d заявок", len(files))
        for f in files:
            try:
                record = json.loads(f.read_text(encoding="utf-8"))
            except Exception as exc:
                log.error("Битый файл очереди %s: %s", f.name, exc)
                continue
            payload = record.get("payload") or {}
            lead_id = str(payload.get("lead_id") or "")
            try:
                age_h = (
                    datetime.now(timezone.utc)
                    - datetime.fromisoformat(str(record.get("queued_at")))
                ).total_seconds() / 3600
            except Exception:
                age_h = 0.0
            if OUTBOX_GIVE_UP_HOURS > 0 and age_h > OUTBOX_GIVE_UP_HOURS:
                log.error(
                    "Заявка в очереди больше %d ч (lead_id=%s) — прекращаю попытки, "
                    "файл оставлен для ручного разбора",
                    OUTBOX_GIVE_UP_HOURS, lead_id,
                )
                try:
                    f.rename(f.with_suffix(".stale"))
                except Exception:
                    pass
                continue
            log.info("Повтор доставки (lead_id=%s, в очереди %.1f ч)", lead_id, age_h)
            await deliver_to_group(bot, chat_id, payload, [], [], 0)


# ─── HTTP-приёмник лидов ─────────────────────────────────────────────────────
# Реестр доставленных карточек: lead_id → (chat_id, message_id). Нужен для
# stage='updated' (клиент дожал «Отправить» после авто-флаша — редактируем
# существующую карточку вместо новой). Живёт в памяти процесса: после
# рестарта бота дополнение придёт fallback-карточкой «Дополнение к заявке»
# (см. deliver_to_group) — приемлемо, лид не теряется.
_lead_cards: dict[str, tuple[int, int]] = {}
_LEAD_CARDS_LIMIT = 500


# Обратный индекс: (chat_id, message_id) → lead_id. Нужен синхронизации
# статусов — в тексте карточки lead_id не печатается, а по нажатой кнопке
# известно только сообщение.
_card_leads: dict[tuple[int, int], str] = {}


def _lead_by_card(chat_id: int, message_id: int) -> str:
    return _card_leads.get((chat_id, message_id), "")


def _remember_card(lead_id: str, chat_id: int, message_id: int) -> None:
    if not lead_id:
        return
    if len(_lead_cards) >= _LEAD_CARDS_LIMIT:
        # FIFO-вытеснение: dict в питоне хранит порядок вставки. Обратный
        # индекс чистим ТЕМ ЖЕ ключом — иначе он растёт без предела, и в
        # долгоживущем воркере это медленная утечка.
        evicted = next(iter(_lead_cards))
        card = _lead_cards.pop(evicted, None)
        if card is not None:
            _card_leads.pop(card, None)
    _lead_cards[lead_id] = (chat_id, message_id)
    _card_leads[(chat_id, message_id)] = lead_id


async def _try_update_card(
    bot: Bot,
    payload: dict,
    photos: list[Attachment],
    docs: list[Attachment],
    n_missing: int,
) -> bool:
    """stage='updated': редактирует ранее отправленную карточку до полной
    версии (как если бы клиент сразу всё заполнил), шлёт под неё вложения и
    короткое уведомление-ответ. True = получилось; False = карточка неизвестна
    (рестарт бота) или edit упал — вызывающий шлёт fallback-карточку.
    """
    lead_id = str(payload.get("lead_id") or "")
    known = _lead_cards.get(lead_id)
    if not known:
        return False
    card_chat, card_mid = known

    # Карточка после дополнения выглядит как обычная полная заявка — без
    # заголовка «Дополнение» (фидбек A7): stage вырезаем перед форматированием.
    clean = {k: v for k, v in payload.items() if k != "stage"}
    text = format_lead(clean, len(photos), len(docs), n_missing)
    try:
        await asyncio.wait_for(
            bot.edit_message_text(
                text,
                chat_id=card_chat,
                message_id=card_mid,
                reply_markup=qual_kb(),
                disable_web_page_preview=True,
            ),
            timeout=DELIVERY_TIMEOUT,
        )
    except Exception as exc:
        # Типовые причины: сообщение старше 48ч, удалено, «not modified».
        log.warning("edit карточки не удался (lead_id=%s): %s — шлём новую", lead_id, exc)
        return False

    if photos or docs:
        try:
            await _send_attachments(bot, card_chat, photos, docs, reply_to=card_mid)
        except Exception as exc:
            log.warning("Вложения дополнения не отправлены (lead_id=%s): %s", lead_id, exc)
    try:
        await asyncio.wait_for(
            bot.send_message(
                card_chat,
                "📝 <i>Клиент дополнил заявку — карточка выше обновлена</i>",
                reply_to_message_id=card_mid,
                disable_web_page_preview=True,
            ),
            timeout=DELIVERY_TIMEOUT,
        )
    except Exception as exc:
        log.warning("Уведомление о дополнении не отправлено (lead_id=%s): %s", lead_id, exc)
    return True


async def deliver_to_group(
    bot: Bot,
    chat_id: object,
    payload: dict,
    photos: list[Attachment],
    docs: list[Attachment],
    n_missing: int,
) -> None:
    """Доставляет лид в группу с ретраями. Порядок (фидбек E2E 2026-08-13):
    СНАЧАЛА карточка с кнопками, ПОТОМ вложения — ответами под ней. Так каждый
    лид в чате начинается с карточки, а файлы визуально привязаны к ней
    тредом (одним сообщением нельзя: альбом Telegram не смешивает фото с PDF
    и не несёт inline-кнопки). Переживает флапы сети до Telegram. Работает в
    фоне (см. handle_notify) — сайт не ждёт.
    """
    lead_id = str(payload.get("lead_id") or "")
    stage = str(payload.get("stage") or "")

    # Дополнение уже отправленного лида: редактируем старую карточку.
    if stage == "updated" and await _try_update_card(bot, payload, photos, docs, n_missing):
        STATS["sent"] = int(STATS["sent"]) + 1  # type: ignore[arg-type]
        STATS["last_sent_at"] = datetime.now(MSK).isoformat(timespec="seconds")
        log.info("Лид дополнен (edit карточки, lead_id=%s)", lead_id)
        return

    text = format_lead(payload, len(photos), len(docs), n_missing)
    for attempt in range(1, DELIVERY_ATTEMPTS + 1):
        try:
            msg = await asyncio.wait_for(
                bot.send_message(
                    chat_id,
                    text,
                    reply_markup=qual_kb(),
                    disable_web_page_preview=True,
                ),
                timeout=DELIVERY_TIMEOUT,
            )
            _remember_card(lead_id, msg.chat.id, msg.message_id)
            # Вложения — ответами под карточкой. Ошибка тут карточку не
            # отменяет: файлы лежат в DATA_DIR, в карточке есть пометка 📎.
            if photos or docs:
                try:
                    await _send_attachments(bot, chat_id, photos, docs, reply_to=msg.message_id)
                except Exception as exc:
                    log.warning(
                        "Вложения не отправлены (lead_id=%s): %s — карточка уже в группе",
                        lead_id, exc,
                    )
            STATS["sent"] = int(STATS["sent"]) + 1  # type: ignore[arg-type]
            STATS["last_sent_at"] = datetime.now(MSK).isoformat(timespec="seconds")
            log.info(
                "Лид отправлен в группу %s (lead_id=%s, попытка %d/%d)",
                chat_id, lead_id, attempt, DELIVERY_ATTEMPTS,
            )
            outbox_drop(lead_id)  # если заявка лежала в очереди — она доставлена
            # Лид ушёл по таймауту → сразу фиксируем в воронке Метрики.
            if stage == "flushed":
                await send_flushed_conversion(payload)
            return
        except Exception as exc:
            # Тип обязателен: у asyncio.TimeoutError пустой str(), и без него
            # причина падения выглядит в логах как пустая строка (боевой
            # разбор 22.08.2026 — час ушёл на то, чтобы это понять).
            log.warning(
                "Отправка в группу не удалась (lead_id=%s, попытка %d/%d): %s: %s",
                lead_id, attempt, DELIVERY_ATTEMPTS, type(exc).__name__, exc or "—",
            )
            if attempt < DELIVERY_ATTEMPTS:
                await asyncio.sleep(DELIVERY_BACKOFF[attempt - 1])

    STATS["failed"] = int(STATS["failed"]) + 1  # type: ignore[arg-type]
    STATS["last_error"] = f"lead_id={lead_id}: не доставлено за {DELIVERY_ATTEMPTS} попыток"
    log.error(
        "Лид НЕ доставлен в группу (lead_id=%s) — попытки исчерпаны, откладываю в очередь",
        lead_id,
    )
    # Заявка НЕ теряется: ложится на диск и повторяется фоном (outbox_retry_loop).
    outbox_put(payload)


async def handle_notify(request: web.Request) -> web.Response:
    # 0. Без токена бот спит (см. main) — осмысленный 503, а не 500.
    if not BOT_TOKEN or request.app.get("bot") is None:
        return web.json_response({"ok": False, "error": "bot_token_not_set"}, status=503)

    # 1. Аутентификация по общему секрету (X-Bot-Secret, спека §2.2).
    if NOTIFY_SECRET and request.headers.get("X-Bot-Secret", "") != NOTIFY_SECRET:
        return web.json_response({"ok": False, "error": "forbidden"}, status=403)

    # 2. Группа должна быть настроена.
    if not GROUP_CHAT_ID:
        log.error("Пришёл лид, но GROUP_CHAT_ID не задан — некуда слать.")
        return web.json_response(
            {"ok": False, "error": "group_not_configured"}, status=503
        )

    # 3. Тело.
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad_json"}, status=400)
    if not isinstance(data, dict):
        return web.json_response({"ok": False, "error": "bad_json"}, status=400)

    # 4. Доставка — В ФОНЕ с ретраями. Сразу отвечаем {ok:true}, чтобы сайт не
    #    ждал медленный/флапающий Telegram: лид уже сохранён в leads.jsonl
    #    независимо от нас (persist обязателен, notify — нет).
    STATS["received"] = int(STATS["received"]) + 1  # type: ignore[arg-type]
    photos, docs, missing = resolve_attachments(data)
    bot: Bot = request.app["bot"]
    chat_id: object = int(GROUP_CHAT_ID) if re.fullmatch(r"-?\d+", GROUP_CHAT_ID) else GROUP_CHAT_ID

    task = asyncio.create_task(deliver_to_group(bot, chat_id, data, photos, docs, missing))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)

    return web.json_response({"ok": True})


async def handle_health(request: web.Request) -> web.Response:
    """GET /health — состояние бота. ?deep=1 дополнительно пингует Telegram."""
    payload: dict[str, object] = {
        "ok": True,
        "service": "telegram-lead-bot",
        "mode": "active" if BOT_TOKEN else "waiting_for_token",
        "uptime_seconds": int(time.time() - STARTED_AT),
        "group_configured": bool(GROUP_CHAT_ID),
        "pending_delivery": len(_bg_tasks),
        "outbox_pending": outbox_pending(),
        "leads": {
            "received": STATS["received"],
            "sent": STATS["sent"],
            "failed": STATS["failed"],
        },
        "last_sent_at": STATS["last_sent_at"],
        "last_error": STATS["last_error"],
    }
    if not BOT_TOKEN:
        payload["waiting_for"] = "BOT_TOKEN"
    # ?deep=1 — живая проверка доступности Telegram (getMe). Не дёргать часто:
    # при флапе сети ответ может занять до 5 секунд.
    if request.query.get("deep") == "1" and request.app.get("bot") is not None:
        bot: Bot = request.app["bot"]
        try:
            me = await asyncio.wait_for(bot.get_me(), timeout=5)
            payload["telegram_reachable"] = True
            payload["bot_username"] = me.username
        except Exception as exc:
            payload["telegram_reachable"] = False
            payload["telegram_error"] = str(exc)
    return web.json_response(payload)


# ─── Точка входа ─────────────────────────────────────────────────────────────
def log_config() -> None:
    """Что бот РЕАЛЬНО получил из окружения — первым делом в логах.

    Панель раздаёт переменные тремя путями (общие проекта, набор сервиса,
    run.env файла), и молчаливая опечатка в ключе выглядит как «бот не
    поднялся». Секреты печатаем только фактом наличия и длиной.
    """
    def mark(value: str) -> str:
        return f"✓ ({len(value)} симв.)" if value else "— НЕ ЗАДАН"

    # Откуда приехали значения. Без этой строки «переменная не подхватилась»
    # превращается в гадание: файл не тот, файла нет вовсе или его перебило
    # окружение systemd.
    log.info(
        "Окружение: %s",
        f"общий .env проекта — {PROJECT_ENV_FILE}"
        if PROJECT_ENV_FILE
        else "файл .env не найден, значения только из окружения (systemd/панель)",
    )

    log.info(
        "Конфиг telegram-bot: BOT_TOKEN %s · GROUP_CHAT_ID %s · порт %s:%s · "
        "NOTIFY_SECRET %s · DATA_DIR %s · METRIKA_COUNTER_ID %s · MP-токен %s · OAuth %s",
        mark(BOT_TOKEN),
        GROUP_CHAT_ID or "— НЕ ЗАДАН",
        NOTIFY_HOST, NOTIFY_PORT,
        mark(NOTIFY_SECRET),
        DATA_DIR or "— НЕ ЗАДАН (вложения не уйдут)",
        METRIKA_COUNTER_ID or "—",
        mark(METRIKA_MP_TOKEN),
        mark(METRIKA_OAUTH_TOKEN),
    )


async def health_watchdog(bot: Bot, chat_id: str) -> None:
    """Периодически проверяет сайт и пишет в СЛУЖЕБНЫЙ чат об авариях.

    Никогда не пишет в группу заявок — chat_id приходит только из
    MONITOR_CHAT_ID, и без него задача вообще не запускается.

    Сознательное ограничение: если ляжет сам этот воркер (или весь сервер),
    предупредить будет некому. Именно поэтому основной мониторинг — внешний
    (UptimeRobot по /api/health/), а этот watchdog нужен для случая «процессы
    живы, но сайт отвечает ошибкой или второй бот отвалился».
    """
    if not HEALTH_URL or HEALTH_URL in {"0", "off"}:
        log.info("Watchdog выключен (HEALTH_URL пуст)")
        return

    log.info(
        "Watchdog: проверяю %s каждые %d с, алерты в чат %s",
        HEALTH_URL, HEALTH_INTERVAL, chat_id,
    )
    healthy = True          # считаем, что на старте всё хорошо
    fails = 0

    # Не проверяем сразу после старта: воркер поднимается вместе с релизом, и
    # сайт в этот момент может ещё запускаться.
    await asyncio.sleep(HEALTH_START_DELAY)

    while True:
        detail = ""
        ok = False
        try:
            timeout = ClientTimeout(total=20)
            async with ClientSession(timeout=timeout) as session:
                async with session.get(HEALTH_URL) as resp:
                    ok = resp.status == 200
                    if not ok:
                        detail = f"код ответа {resp.status}"
                        try:
                            payload = await resp.json(content_type=None)
                            broken = [
                                str(w.get("name"))
                                for w in payload.get("workers", [])
                                if not w.get("ok")
                            ]
                            if broken:
                                detail += ": не отвечает " + ", ".join(broken)
                        except Exception:
                            pass  # тело не JSON (например, страница ошибки Caddy)
        except Exception as exc:
            detail = f"сайт не отвечает ({type(exc).__name__})"

        if ok:
            fails = 0
            if not healthy:
                healthy = True
                await _safe_notify(
                    bot, chat_id,
                    "✅ <b>Сайт снова в норме</b>\n\nЗаявки принимаются.",
                )
            await asyncio.sleep(HEALTH_INTERVAL)
            continue

        fails += 1
        log.warning("Watchdog: проверка провалена (%d/%d) — %s",
                    fails, HEALTH_FAILS_BEFORE_ALERT, detail)
        if healthy and fails >= HEALTH_FAILS_BEFORE_ALERT:
            healthy = False
            await _safe_notify(
                bot, chat_id,
                f"🔴 <b>Проблема с сайтом {esc(BRAND_NAME)}</b>\n\n"
                f"{detail}\n\n⚠️ Заявки с сайта могут не доходить.",
            )
        await asyncio.sleep(HEALTH_INTERVAL)


async def _safe_notify(bot: Bot, chat_id: str, text: str) -> None:
    """Алерт не должен ронять watchdog: сеть до Telegram тут тоже флапает."""
    try:
        await bot.send_message(chat_id, text, disable_web_page_preview=True)
    except Exception as exc:
        log.error("Watchdog: не удалось отправить алерт: %s", exc)


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log_config()

    # HTTP-приёмник поднимаем ВСЕГДА, даже без токена: /health нужен
    # healthcheck'у Freim Deploy. Без токена бот спит (как MAX-бот) — раньше
    # он падал с SystemExit, и одна незаполненная переменная роняла деплой
    # ВСЕГО релиза, включая сайт (правка 2026-08-14).
    app = web.Application()
    app["bot"] = None
    app.router.add_post("/notify", handle_notify)
    app.router.add_post("/peer-status", handle_peer_status)
    app.router.add_get("/health", handle_health)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, NOTIFY_HOST, NOTIFY_PORT)
    try:
        await site.start()
    except OSError as exc:
        raise SystemExit(
            f"Не удалось занять {NOTIFY_HOST}:{NOTIFY_PORT} ({exc}).\n"
            f"Две причины, обе частые — проверьте В ЭТОМ порядке:\n"
            f"1) Порт занял ДРУГОЙ ПРОЕКТ на этом же сервере. Порты ботов не "
            f"уникальны сами по себе: 8091/8092 — всего лишь дефолт, и второй "
            f"проект на том же хосте обречён, пока ему не выдали свою пару. "
            f"Проверить: ss -ltnp | grep {NOTIFY_PORT}. Лечится выдачей своей "
            f"пары портов в TELEGRAM_NOTIFY_PORT / MAX_NOTIFY_PORT (и теми же "
            f"числами в LEAD_NOTIFY_URLS сайта).\n"
            f"2) Оба бота получили один и тот же безпрефиксный NOTIFY_PORT из "
            f"ОБЩИХ переменных проекта — тогда задайте префиксные "
            f"TELEGRAM_NOTIFY_PORT и MAX_NOTIFY_PORT."
        ) from exc
    log.info("Приёмник лидов слушает http://%s:%s/notify", NOTIFY_HOST, NOTIFY_PORT)

    if not BOT_TOKEN:
        log.warning(
            "BOT_TOKEN не задан — бот мирно спит (mode=waiting_for_token), "
            "/notify отвечает 503. Впишите токен от @BotFather в env сервиса "
            "и перезапустите."
        )
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:
                pass
        await stop.wait()
        await runner.cleanup()
        return

    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    app["bot"] = bot
    dp = Dispatcher()
    dp.include_router(router)

    if not DATA_DIR:
        log.warning("DATA_DIR не задан — вложения лидов отправляться не будут")

    try:
        me = await bot.get_me()
        log.info(
            "Бот @%s запущен. Группа: %s",
            me.username,
            GROUP_CHAT_ID or "НЕ ЗАДАНА — отправьте /id в группе",
        )
    except Exception as exc:
        # Неверный токен / нет сети до api.telegram.org. НЕ падаем: процесс
        # держит /health и /notify, ошибка видна в логах и в /health?deep=1,
        # а polling ниже сам переживёт восстановление сети.
        log.error(
            "Не удалось получить getMe (%s). Проверьте BOT_TOKEN и доступность "
            "api.telegram.org. Бот продолжит попытки.", exc,
        )

    # Повтор недоставленных заявок. Ссылку держим отдельно от _bg_tasks: там
    # доставки, которых ждут при остановке сервиса, а этот цикл бесконечный —
    # ждать его нельзя. Запускается всегда, когда известна группа: это не
    # мониторинг, а доставка заявок.
    outbox_task: asyncio.Task | None = None
    if GROUP_CHAT_ID:
        outbox_task = asyncio.create_task(outbox_retry_loop(bot, GROUP_CHAT_ID))
        pending = outbox_pending()
        if pending:
            log.warning("В очереди повторов уже лежит заявок: %d", pending)

    # Ссылку держим отдельно от _bg_tasks: там лежат доставки лидов, которых
    # ждут при остановке сервиса, а watchdog бесконечный — ждать его нельзя.
    # Запускаем ТОЛЬКО при отдельном служебном чате: в группу заявок алерты
    # не шлём никогда, даже если очень хочется.
    watchdog_task: asyncio.Task | None = None
    if MONITOR_CHAT_ID:
        watchdog_task = asyncio.create_task(health_watchdog(bot, MONITOR_CHAT_ID))
    else:
        log.info(
            "Watchdog не запущен: MONITOR_CHAT_ID не задан. Внешний мониторинг "
            "(UptimeRobot и т.п.) настраивается на %s — см. docs/recipes/monitoring.md",
            HEALTH_URL or "<HEALTH_URL не задан>",
        )

    try:
        # Сбрасываем возможный вебхук Telegram, иначе polling конфликтует.
        try:
            await bot.delete_webhook(drop_pending_updates=False)
        except Exception as exc:
            log.warning("delete_webhook не выполнен: %s", exc)
        try:
            await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
        except TelegramUnauthorizedError:
            # Токен с опечаткой (или отозванный @BotFather). Падать нельзя:
            # процесс держит приёмник /notify, и без него сайт получает
            # «connection refused» вместо честного ответа бота, а /health
            # молчит — под systemd это выглядит как перезапускающийся сервис
            # без объяснения причины. Выше по коду ту же ошибку на getMe уже
            # переживают сознательно; polling ронял её мимо той защиты.
            log.error(
                "Telegram отверг BOT_TOKEN (Unauthorized). Команды и доставка "
                "карточек работать не будут, пока токен не исправлен, но "
                "приёмник лидов остаётся жив: заявки принимаются и ждут в "
                "очереди повторов. Проверьте токен у @BotFather."
            )
            STATS["last_error"] = "BOT_TOKEN отвергнут Telegram (Unauthorized)"
            stop = asyncio.Event()
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGTERM, signal.SIGINT):
                try:
                    loop.add_signal_handler(sig, stop.set)
                except NotImplementedError:
                    pass
            await stop.wait()
    finally:
        if watchdog_task is not None:
            watchdog_task.cancel()  # бесконечный цикл — снимаем сразу
        if outbox_task is not None:
            outbox_task.cancel()
        # Дать лидам «в полёте» шанс доставиться до остановки сервиса.
        if _bg_tasks:
            log.info("Ждём доставки %d лидов перед остановкой…", len(_bg_tasks))
            try:
                await asyncio.wait_for(
                    asyncio.gather(*_bg_tasks, return_exceptions=True), timeout=20
                )
            except asyncio.TimeoutError:
                log.warning("Не все лиды успели доставиться до остановки")
        await runner.cleanup()
        await bot.session.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except SystemExit as exc:
        # SystemExit НЕ глотаем: он остался ровно для одного случая — порт
        # занят (см. main). Дублируем в лог, чтобы причина была видна в
        # журнале сервиса, а не только в stderr. Отсутствие токена больше не
        # падение: бот спит, деплой цел.
        if exc.code not in (None, 0):
            log.error("Остановка: %s", exc)
        raise
