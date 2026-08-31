#!/usr/bin/env python3
"""
Бот приёма лидов с сайта для мессенджера MAX (max.ru) — модуль astro-starter, порт с боевого проекта.

Что делает:
  1. Поднимает локальный HTTP-приёмник `POST /notify` — сайт (Astro) шлёт сюда
     лид (полный или flushed-черновик, см. спеку §2.2). Бот форматирует его в
     карточку (единый формат со спекой §3, как у Telegram-бота) и постит в
     группу MAX вместе с фото/PDF и инлайн-кнопками квалификации.
  2. Фоновая задача long polling `GET /updates` — ловит нажатия callback-кнопок
     (✅ Квал / 🔝 Целевой / ❌ Отказ) и событие `bot_added` (подсказывает
     chat_id группы для env).
  3. Кнопки квалификации шлют server-side цели в Яндекс.Метрику
     (Measurement Protocol); при доставке flushed-карточки — цель lead_flushed.

Особенности MAX Bot API (авг-2026), учтённые здесь:
  • base URL https://botapi.max.ru — публичный хост Bot API, обычный
    сертификат Let's Encrypt: доп. CA НЕ нужен (проверено 2026-08-14).
    Переопределяется env MAX_API_BASE; для внутреннего platform-api2.max.ru
    понадобится ещё и CA Минцифры (RUSSIAN_TRUSTED_CA_PATH);
  • токен кладётся в Authorization СЫРОЙ строкой (без «Bearer»);
  • text+attachments+inline_keyboard живут в ОДНОМ сообщении — карточка с фото
    и кнопками уходит одним постом;
  • ответ на callback — POST /answers?callback_id=… с {message: NewMessageBody},
    он АТОМАРНО заменяет карточку (текст+вложения+клавиатуру);
  • окно редактирования 24 ч — старой карточке шлём реплай со статусом;
  • GET /chats deprecated → chat_id группы ловим из событий bot_added /
    message_created (бот должен быть АДМИНОМ группы, иначе событий нет).

Работаем на сыром httpx (4 эндпоинта: /messages, /answers, /uploads, /updates) —
полный контроль над ssl-контекстом, без зависимости от свежести community-SDK.

КРИТИЧНО (Freim Deploy-worker): без MAX_TOKEN процесс НЕ падает — мирно спит,
/health отвечает «waiting_for_token», /notify отдаёт 503. Появился токен →
рестарт сервиса → полноценный режим.

Запуск:  python bot.py   (переменные берутся из .env рядом с файлом)
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import mimetypes
import os
import re
import signal
import ssl
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import certifi
import httpx
from aiohttp import web

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
    ботов обязаны различаться, есть префиксное имя — `MAX_NOTIFY_PORT`
    против `TELEGRAM_NOTIFY_PORT`. Безпрефиксное имя остаётся как фолбэк для
    посервисных наборов и локального .env.
    """
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return default


MAX_TOKEN = _env("MAX_TOKEN")
MAX_CHAT_ID = _env("MAX_CHAT_ID")
# Общий секрет с сайтом. Имя сайта — LEAD_NOTIFY_SECRET; безпрефиксное
# NOTIFY_SECRET остаётся фолбэком для посервисных наборов панели.
NOTIFY_SECRET = _env("LEAD_NOTIFY_SECRET", "NOTIFY_SECRET")
NOTIFY_HOST = _env("NOTIFY_HOST", default="127.0.0.1")
NOTIFY_PORT = int(_env("MAX_NOTIFY_PORT", "NOTIFY_PORT", default="8092"))
# Корень файлового хранилища сайта (= <baseDir>/shared/data). Пути вложений
# в payload — относительные от него: attachments/<lead_id>/N.ext
# Тот же каталог, что у сайта: сайт кладёт вложения, бот их читает.
DATA_DIR = _env("LEAD_DATA_DIR", "DATA_DIR")

# ── Яндекс.Метрика (серверные конверсии воронки по кнопкам квалификации) ─────
# METRIKA_MP_TOKEN: Метрика → Настройки счётчика → Measurement Protocol →
# включить → токен. Пусто → отправка целей тихо пропускается.
# Тот же счётчик, что у сайта (PUBLIC_YANDEX_METRIKA_ID) — второго номера
# у проекта не бывает, а две переменные под одно число разъезжаются.
METRIKA_COUNTER_ID = _env("METRIKA_COUNTER_ID", "PUBLIC_YANDEX_METRIKA_ID")
METRIKA_MP_TOKEN = _env("METRIKA_MP_TOKEN")
# OAuth-токен для Offline Conversions API (scope metrika:offline_data или
# metrika:write; живёт 1 год). Задан → квал-кнопки идут офлайн-конверсиями
# (окно 21 день); пуст → фолбэк на Measurement Protocol (окно 12 часов).
METRIKA_OAUTH_TOKEN = _env("METRIKA_OAUTH_TOKEN")

# PEM-файл Russian Trusted Root CA (Минцифры). НЕ НУЖЕН для дефолтного хоста:
# botapi.max.ru выписан Let's Encrypt и проходит проверку обычным certifi
# (проверено 2026-08-14). Переменная — аварийный выход на случай, если
# MAX_API_BASE укажут на platform-api2.max.ru: тот подписан сертификатом
# Минцифры, которого нет ни в одном стандартном CA-bundle.
# Где взять PEM: https://www.gosuslugi.ru/crt
RUSSIAN_TRUSTED_CA_PATH = os.getenv("RUSSIAN_TRUSTED_CA_PATH", "").strip()

# Europe/Moscow = UTC+3 круглый год (без переходов) — фиксированный офсет,
# чтобы не тянуть tz-базу.
TZ_OFFSET_HOURS = int(_env("TZ_OFFSET_HOURS", default="3"))
MSK = timezone(timedelta(hours=TZ_OFFSET_HOURS))

# Название проекта/бренда для заголовков карточек и текстов команд.
BRAND_NAME = _env("BRAND_NAME", default="Сайт")

# Базовый URL Bot API. `botapi.max.ru` — публичный хост из документации
# dev.max.ru: обычный сертификат Let's Encrypt, никаких доп. CA не нужно.
# Проверено 2026-08-14: /me, /messages, /chats, POST /uploads, POST /answers,
# PUT /messages отвечают 401 без токена, то есть существуют.
# (Прежний `platform-api2.max.ru` подписан сертификатом Минцифры и без его
# корневого CA не поднимает TLS вообще — см. RUSSIAN_TRUSTED_CA_PATH.)
# _env, а НЕ os.getenv: в общем .env переменная присутствует всегда, и
# пустая строка перебила бы дефолт — бот пошёл бы стучаться в "" вместо
# botapi.max.ru. _env считает пустое значение незаданным.
MAX_API_BASE = _env("MAX_API_BASE", default="https://botapi.max.ru")

log = logging.getLogger("max-bot")

# ── Очередь недоставленных и связь с Telegram-ботом ──────────────────────────
# 22.08.2026 заявка ушла в MAX, но не в Telegram: там сгорели пять попыток за
# две минуты. Симметричная защита нужна обоим — сеть может отвалиться с любой
# стороны. Недоставленное ложится файлом в общий DATA_DIR и повторяется фоном.
OUTBOX_RETRY_SECONDS = int(_env("OUTBOX_RETRY_SECONDS", default="300"))
OUTBOX_GIVE_UP_HOURS = int(_env("OUTBOX_GIVE_UP_HOURS", default="24"))
# Одна заявка лежит в обоих чатах. Нажали статус здесь — сосед должен показать
# это у себя, иначе второй менеджер перезвонит тому же человеку.
# Префиксное имя первым — см. комментарий в telegram-боте: общая переменная
# проекта досталась бы обоим, и каждый слал бы статус себе.
# Порт соседа — из ЕГО переменной (см. комментарий в telegram-боте): общие
# переменные проекта достаются всем сервисам, значит TELEGRAM_NOTIFY_PORT
# виден и здесь, и смена порта в панели не рассинхронизирует ботов.
_PEER_NOTIFY_PORT = _env("TELEGRAM_NOTIFY_PORT", default="8091")
PEER_STATUS_URL = _env(
    "MAX_PEER_STATUS_URL",
    default=f"http://127.0.0.1:{_PEER_NOTIFY_PORT}/peer-status",
)

# ─── Состояние для /health и фоновой доставки ────────────────────────────────
STARTED_AT = time.time()
STATS: dict[str, object] = {
    "received": 0,       # лидов пришло на /notify
    "sent": 0,           # карточек доставлено в группу
    "failed": 0,         # карточек НЕ доставлено (после всех ретраев)
    "callbacks": 0,      # нажатий кнопок обработано
    "last_sent_at": None,
    "last_error": None,
}
# Ссылки на фоновые задачи доставки — чтобы их не собрал GC до завершения.
_bg_tasks: set[asyncio.Task] = set()

# Доставка карточки переживает флапы сети: 5 попыток с паузами (как в
# боте эталона-каталога).
DELIVERY_ATTEMPTS = 5
DELIVERY_BACKOFF = [2, 4, 8, 16]   # паузы между попытками 1..4
# attachment.not.ready: сервер MAX ещё обрабатывает загруженный файл —
# повторяем отправку сообщения с задержкой.
NOT_READY_ATTEMPTS = 3
NOT_READY_BACKOFF = [1, 2, 4]

# Лимиты MAX
MAX_TEXT_LIMIT = 4000          # text в NewMessageBody
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 МБ на файл
EDIT_WINDOW_SECONDS = 24 * 3600      # окно редактирования сообщения

# Кэш HTML-текста и вложений отправленных карточек: mid → {"text", "attachments"}.
# Нужен, чтобы при callback пересобрать карточку с исходной HTML-разметкой
# (update отдаёт plain-текст без тегов). Ограничен по размеру, LRU.
_CARD_CACHE: OrderedDict[str, dict] = OrderedDict()
_CARD_CACHE_LIMIT = 500


def _cache_card(mid: str, text: str, attachments: list[dict]) -> None:
    """Запоминает карточку для последующей атомарной замены по callback."""
    if not mid:
        return
    _CARD_CACHE[mid] = {"text": text, "attachments": attachments}
    _CARD_CACHE.move_to_end(mid)
    while len(_CARD_CACHE) > _CARD_CACHE_LIMIT:
        _CARD_CACHE.popitem(last=False)


# ─── SSL-контексты ───────────────────────────────────────────────────────────
def build_max_ssl_context() -> ssl.SSLContext:
    """CA-bundle для MAX API: certifi, плюс (опционально) CA Минцифры.

    Дефолтный `botapi.max.ru` подписан Let's Encrypt — certifi его знает,
    ничего доустанавливать не надо. Доп. CA нужен ТОЛЬКО если MAX_API_BASE
    указывает на `platform-api2.max.ru` (сертификат Минцифры). Поэтому
    отсутствие RUSSIAN_TRUSTED_CA_PATH — норма и молчит; предупреждаем лишь
    когда путь задан, но нерабочий, и когда хост требует доп. CA, а его нет.
    """
    ctx = ssl.create_default_context(cafile=certifi.where())
    if RUSSIAN_TRUSTED_CA_PATH:
        if os.path.isfile(RUSSIAN_TRUSTED_CA_PATH):
            try:
                ctx.load_verify_locations(cafile=RUSSIAN_TRUSTED_CA_PATH)
                log.info("Доп. CA (Минцифры) подгружен: %s", RUSSIAN_TRUSTED_CA_PATH)
            except ssl.SSLError as exc:
                log.warning(
                    "Не удалось загрузить CA из %s: %s — работаем на certifi",
                    RUSSIAN_TRUSTED_CA_PATH, exc,
                )
        else:
            log.warning(
                "RUSSIAN_TRUSTED_CA_PATH задан, но файла нет: %s — работаем на certifi",
                RUSSIAN_TRUSTED_CA_PATH,
            )
    elif "platform-api" in MAX_API_BASE:
        log.warning(
            "MAX_API_BASE=%s подписан сертификатом Минцифры, а "
            "RUSSIAN_TRUSTED_CA_PATH не задан — TLS не поднимется. Либо задайте "
            "путь к PEM (gosuslugi.ru/crt), либо уберите MAX_API_BASE: дефолтный "
            "botapi.max.ru работает без доп. сертификатов.",
            MAX_API_BASE,
        )
    return ctx


def build_default_ssl_context() -> ssl.SSLContext:
    """Обычный certifi-контекст — для mc.yandex.ru (НЕ Минцифры)."""
    return ssl.create_default_context(cafile=certifi.where())


# ─── Форматирование карточки (единый формат со спекой §3) ────────────────────
# Подписи типа заявки (payload.type) — те же env-переменные, что у Telegram-бота.
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

# Домены сайта: у своих страниц в карточке показываем только путь (см.
# page_label). Задаётся env
# SITE_HOSTS (через запятую); пусто — безопасно, пути покажутся с доменом.
SITE_HOSTS = {
    h.strip().removeprefix("www.").lower()
    for h in _env("SITE_HOSTS", default="").split(",")
    if h.strip()
}
if not SITE_HOSTS:
    log.warning("SITE_HOSTS не задан — ссылки страниц будут показаны URL-ом целиком")

FLUSHED_LINE = (
    "⏱ <i>Авто-отправка: клиент оставил телефон и согласие, но не нажал «Отправить»</i>"
)
FOOTER_SEP = "———"


def esc(value: object) -> str:
    """HTML-экранирование для format=html."""
    return html.escape(str(value), quote=False)


def fmt_phone(raw: str) -> str:
    """+79001234567 → +7 (900) 123-45-67. Мусор возвращаем как есть."""
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 11 and digits[0] in "78":
        digits = digits[1:]
    if len(digits) == 10:
        return f"+7 ({digits[0:3]}) {digits[3:6]}-{digits[6:8]}-{digits[8:10]}"
    return raw or "—"


def _row(label: str, value: object) -> str | None:
    """Строка `• label: value`, если значение непустое.

    Формат `label: value` парсится обратно кнопками квалификации
    (_extract_field) — маркер списка на разбор не влияет, но менять
    двоеточие нельзя.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return f"• {label}: {esc(text)}"


def page_label(raw: object) -> str:
    """URL страницы → путь без схемы и домена: `/catalog/item/slug/`.

    MAX разворачивает ЛЮБУЮ ссылку в сообщении в OG-превью (картинка + тайтл
    сайта), и отключить это нечем: в NewMessageBody нет флага вроде
    telegram'ского disable_web_page_preview (проверено по dev.max.ru/docs-api,
    2026-08-15) — есть только text/attachments/link/notify/format. Поэтому
    убираем не превью, а повод для него: голый путь ссылкой не считается.
    Менеджеру домен и не нужен — сайт один, важно «с какой страницы».
    Чужой домен (теоретически) оставляем видимым, но тоже без схемы.
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
    if host in SITE_HOSTS:
        return tail
    return f"{host}{tail}"


def _plural_files(n: int) -> str:
    """1 файл / 2 файла / 5 файлов."""
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} файл"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return f"{n} файла"
    return f"{n} файлов"


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


def format_lead(data: dict, attach_note: str | None) -> str:
    """Собирает HTML-карточку лида (спека §3).

    attach_note — строка про файлы («📎 3 файла (во вложении)» /
    «📎 файл недоступен») или None, если файлов нет.
    """
    name = str(data.get("name") or "Клиент с сайта").strip() or "Клиент с сайта"
    phone_raw = str(data.get("phone") or "").strip()
    stage = str(data.get("stage") or "")

    # stage='updated' — клиент дожал «Отправить» после авто-флаша: сайт
    # присылает полный лид повторно. MAX-бот шлёт его новой карточкой с
    # заголовком «Дополнение» (в отличие от TG, где редактируется старая).
    if stage == "updated":
        lines: list[str] = [f"📝 <b>Дополнение к заявке</b> — {esc(BRAND_NAME)}"]
    else:
        lines = [f"📩 <b>Новая заявка</b> — {esc(BRAND_NAME)}"]
    if stage == "flushed":
        lines.append(FLUSHED_LINE)
    lines.append("")

    lines.append(f"👤 <b>{esc(name)}</b>")
    if phone_raw:
        # tel:-ссылку HTML MAX может не поддержать — телефон просто текстом.
        lines.append(f"📞 {esc(fmt_phone(phone_raw))}")

    # 📋 Тип: … · Связь: телефон|мессенджер
    type_raw = str(data.get("type") or "").strip()
    contact_raw = str(data.get("contactMethod") or "").strip()
    parts: list[str] = []
    if type_raw:
        parts.append(f"Тип: {esc(TYPE_LABELS.get(type_raw, type_raw))}")
    if contact_raw:
        parts.append(f"Связь: {esc(CONTACT_LABELS.get(contact_raw, contact_raw))}")
    if parts:
        lines.append("📋 " + " · ".join(parts))

    # 🎯 По мотивам: <case> (если есть prefill/case)
    case = str(data.get("case") or data.get("prefill") or "").strip()
    if case:
        lines.append(f"🎯 По мотивам: {esc(case)}")

    # 💬 сообщение клиента — отдельным блоком с заголовком (как в TG-карточке;
    # blockquote там заменён на пустую строку + заголовок: MAX из форматирования
    # поддерживает только b/i/u/s/a/code/pre, цитат у него нет).
    message = str(data.get("message") or "").strip()
    if message:
        if len(message) > 1500:
            message = message[:1500].rstrip() + "…"
        lines.append("")
        lines.append("💬 <b>Комментарий</b>")
        lines.append(esc(message))

    if attach_note:
        lines.append("")
        lines.append(attach_note)

    # ── Аналитика / метки ───────────────────────────────────────────────────
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
        lines.extend(analytics)

    # ── Время + источник ────────────────────────────────────────────────────
    created = _parse_dt(data.get("completed_at") or data.get("created_at"))
    source_raw = str(data.get("source") or "").strip()
    stamp = f"🕒 {created.strftime('%d.%m.%Y %H:%M')} (МСК)"
    if source_raw:
        stamp += f" · источник: {esc(SOURCE_LABELS.get(source_raw, source_raw))}"
    lines.append("")
    lines.append(stamp)

    text = "\n".join(lines)
    # Финальный предохранитель лимита MAX (4000): режем по последней строке.
    if len(text) > MAX_TEXT_LIMIT:
        text = text[: MAX_TEXT_LIMIT - 1]
        cut = text.rfind("\n")
        if cut > 0:
            text = text[:cut]
        text += "…"
    return text


# ─── Инлайн-кнопки квалификации ──────────────────────────────────────────────
STATUS_LABELS = {
    "qual": "✅ Квал",
    "target": "🔝 Целевой",
    "reject": "❌ Отказ",
}
# Кнопка → server-side цель Метрики (завести в интерфейсе как JS-событие).
STAGE_GOALS = {
    "qual": "lead_qualified",
    "target": "lead_target",
    "reject": "lead_rejected",
}


def status_keyboard() -> dict:
    """Attachment inline_keyboard: [✅ Квал] [🔝 Целевой] [❌ Отказ]."""
    return {
        "type": "inline_keyboard",
        "payload": {
            "buttons": [
                [
                    {"type": "callback", "text": "✅ Квал", "payload": "lead:qual"},
                    {"type": "callback", "text": "🔝 Целевой", "payload": "lead:target"},
                    {"type": "callback", "text": "❌ Отказ", "payload": "lead:reject"},
                ]
            ]
        },
    }


# ─── Клиент MAX Bot API (сырой httpx, 4 эндпоинта) ───────────────────────────
class MaxApiError(Exception):
    """Не-2xx ответ MAX API."""

    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body


class MaxClient:
    """Минимальный клиент platform-api2.max.ru.

    Токен — сырой строкой в Authorization (БЕЗ Bearer). Rate limit MAX —
    30 rps; при наших объёмах (<100 лидов/день) отдельный лимитер не нужен.
    """

    def __init__(self, token: str, ssl_context: ssl.SSLContext):
        self._client = httpx.AsyncClient(
            base_url=MAX_API_BASE,
            headers={"Authorization": token},
            verify=ssl_context,
            timeout=httpx.Timeout(20.0, connect=10.0),
        )

    async def close(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _check(resp: httpx.Response) -> dict:
        if resp.status_code // 100 != 2:
            raise MaxApiError(resp.status_code, resp.text)
        try:
            return resp.json()
        except Exception:
            return {}

    async def send_message(
        self,
        chat_id: str,
        text: str,
        attachments: list[dict] | None = None,
        link: dict | None = None,
    ) -> dict:
        """POST /messages?chat_id=… — карточка одним сообщением.

        attachment.not.ready (сервер ещё обрабатывает загруженный файл) →
        ретрай 3 попытки с паузами 1/2/4 c.
        """
        body: dict = {"text": text, "format": "html", "notify": True}
        if attachments:
            body["attachments"] = attachments
        if link:
            body["link"] = link

        last_exc: Exception | None = None
        for attempt in range(1, NOT_READY_ATTEMPTS + 1):
            try:
                resp = await self._client.post(
                    "/messages", params={"chat_id": chat_id}, json=body
                )
                return self._check(resp)
            except MaxApiError as exc:
                last_exc = exc
                if "attachment.not.ready" in exc.body and attempt < NOT_READY_ATTEMPTS:
                    delay = NOT_READY_BACKOFF[attempt - 1]
                    log.info(
                        "MAX ещё обрабатывает вложения (attachment.not.ready), "
                        "повтор через %d c (попытка %d/%d)",
                        delay, attempt, NOT_READY_ATTEMPTS,
                    )
                    await asyncio.sleep(delay)
                    continue
                raise
        raise last_exc  # type: ignore[misc]  # недостижимо, для mypy

    async def edit_message(
        self, mid: str, text: str, attachments: list[dict] | None = None
    ) -> dict:
        """PUT /messages?message_id=… — правка ранее отправленной карточки.

        Используется, когда клиент дожал «Отправить» после авто-флаша
        (stage=updated): карточка доводится до полной версии вместо второй,
        как и в Telegram-боте. Окно правки у MAX — 24 ч; ошибка (старое
        сообщение, метод недоступен) пробрасывается наверх, вызывающий
        откатывается на отдельную карточку «Дополнение к заявке».
        """
        body: dict = {"text": text, "format": "html"}
        if attachments is not None:
            body["attachments"] = attachments
        resp = await self._client.put("/messages", params={"message_id": mid}, json=body)
        return self._check(resp)

    async def answer_callback(
        self,
        callback_id: str,
        message: dict | None = None,
        notification: str | None = None,
    ) -> dict:
        """POST /answers?callback_id=… — атомарная замена карточки или тост."""
        body: dict = {}
        if message is not None:
            body["message"] = message
        if notification is not None:
            body["notification"] = notification
        resp = await self._client.post(
            "/answers", params={"callback_id": callback_id}, json=body
        )
        return self._check(resp)

    async def upload(
        self, upload_type: str, path: Path, mime: str, filename: str | None = None
    ) -> str | None:
        """POST /uploads?type=… → multipart-заливка → токен вложения.

        Для image/file токен приходит в ответе ЗАЛИВКИ (не первого запроса).
        Возвращает token или None (не удалось распарсить).
        """
        resp = await self._client.post("/uploads", params={"type": upload_type})
        data = self._check(resp)
        upload_url = data.get("url")
        # Для video/audio токен приходит сразу — на будущее поддержим.
        token = data.get("token")
        if not upload_url:
            return token

        content = path.read_bytes()
        up = await self._client.post(
            upload_url,  # абсолютный URL (upload.max.ru) — тот же ssl-контекст
            # Имя — исходное клиентское («смета-кухня.pdf»), а не «2.pdf» с диска.
            files={"data": (filename or path.name, content, mime)},
            timeout=httpx.Timeout(120.0, connect=10.0),
        )
        if up.status_code // 100 != 2:
            raise MaxApiError(up.status_code, up.text)
        try:
            up_data = up.json()
        except Exception:
            return token
        # Формат ответа: {"token": …} либо {"photos": {"…": {"token": …}}}
        if isinstance(up_data.get("token"), str):
            return up_data["token"]
        photos = up_data.get("photos")
        if isinstance(photos, dict):
            for value in photos.values():
                if isinstance(value, dict) and value.get("token"):
                    return value["token"]
        return token

    async def get_updates(self, marker: int | None) -> dict:
        """GET /updates — long polling (работает, пока нет webhook-подписки)."""
        params: dict = {
            "timeout": 90,
            "types": "message_created,message_callback,bot_started,bot_added",
        }
        if marker is not None:
            params["marker"] = marker
        resp = await self._client.get(
            "/updates",
            params=params,
            # Ждём дольше серверного таймаута long poll (90 c).
            timeout=httpx.Timeout(110.0, connect=10.0),
        )
        return self._check(resp)


# Глобальные ссылки (заполняются в main, если есть токен).
API: MaxClient | None = None
METRIKA_CLIENT: httpx.AsyncClient | None = None


# ─── Вложения лида: DATA_DIR + attachments[].path → токены MAX ───────────────
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".tiff"}


def _resolve_attachment_path(rel_path: str) -> Path | None:
    """Безопасно резолвит относительный путь внутри DATA_DIR (без traversal)."""
    if not DATA_DIR or not rel_path:
        return None
    base = Path(DATA_DIR).resolve()
    candidate = (base / rel_path).resolve()
    if not candidate.is_relative_to(base):
        log.warning("Путь вложения выходит за DATA_DIR, пропущен: %s", rel_path)
        return None
    if not candidate.is_file():
        log.warning("Файл вложения не найден: %s", candidate)
        return None
    return candidate


async def upload_lead_attachments(api: MaxClient, data: dict) -> tuple[list[dict], str | None]:
    """Заливает файлы лида в MAX. → (attachments для сообщения, строка «📎 …»).

    Фото → type=image, PDF (и прочее) → type=file. Если ни один файл не
    загрузился — карточка уходит без вложений со строкой «📎 файл недоступен».
    """
    items = data.get("attachments") or []
    if not isinstance(items, list) or not items:
        return [], None

    uploaded: list[dict] = []
    total = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        total += 1
        path = _resolve_attachment_path(str(item.get("path") or ""))
        if path is None:
            continue
        if path.stat().st_size > MAX_UPLOAD_BYTES:
            log.warning("Файл больше 50 МБ, пропущен: %s", path)
            continue

        mime = str(item.get("mime") or "") or (
            mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        )
        is_image = path.suffix.lower() in IMAGE_EXTS or mime.startswith("image/")
        upload_type = "image" if is_image else "file"
        # Исходное имя от клиента (на диске лежит обезличенное «2.pdf»).
        raw_name = str(item.get("name") or "").strip()
        filename = os.path.basename(raw_name.replace("\\", "/")) or path.name
        try:
            token = await api.upload(upload_type, path, mime, filename)
        except Exception as exc:
            log.warning("Не удалось залить вложение %s: %s", path, exc)
            continue
        if not token:
            log.warning("MAX не вернул токен для вложения %s", path)
            continue
        uploaded.append({"type": upload_type, "payload": {"token": token}})

    if total == 0:
        return [], None
    if not uploaded:
        return [], "📎 файл недоступен"
    if len(uploaded) < total:
        note = f"📎 <b>{_plural_files(len(uploaded))}</b> — во вложении (часть недоступна)"
    else:
        note = f"📎 <b>{_plural_files(len(uploaded))}</b> — во вложении"
    return uploaded, note


# ─── Серверные конверсии (Яндекс.Метрика Measurement Protocol) ───────────────
# ClientID Метрики (_ym_uid) — строка цифр; иначе серверную цель не привязать.
_METRIKA_CID_RE = re.compile(r"^\d{8,}$")
# Дедуп в рамках аптайма процесса. Callback-цели: (mid, goal); lead_flushed:
# (lead_id, goal). При рестарте множество сбрасывается — приемлемо.
_sent_conversions: set[tuple[str, str]] = set()


def _extract_field(text: str, label: str) -> str:
    """Значение строки `• label: value` из текста карточки (или '')."""
    m = re.search(re.escape(label) + r":\s*(\S+)", text or "")
    return m.group(1).strip() if m else ""


async def _mp_collect(goal: str, cid: str, yclid: str = "") -> bool:
    """GET mc.yandex.ru/collect/ — цель через Measurement Protocol.

    mc.yandex.ru — обычный certifi-контекст (сертификат НЕ Минцифры).
    Окно: событие должно попадать в 12 часов после конца визита, позже
    Метрика молча отбрасывает — поэтому канал только для lead_flushed
    (стреляет через 15 мин) и как фолбэк без OAuth-токена.
    """
    if not METRIKA_MP_TOKEN or METRIKA_CLIENT is None:
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
        resp = await METRIKA_CLIENT.get("https://mc.yandex.ru/collect/", params=params)
        if resp.status_code == 200:
            log.info("Цель %s → Метрика MP (cid=%s)", goal, cid)
            return True
        log.warning("Метрика collect %s: HTTP %s %s", goal, resp.status_code, resp.text[:200])
    except Exception as exc:
        log.warning("Не удалось отправить цель %s: %s", goal, exc)
    return False


async def _offline_upload(goal: str, cid: str) -> bool:
    """Одна конверсия через Offline Conversions API (окно привязки 21 день).

    CSV из одной строки: ClientId,Target,DateTime (unix-секунды, момент
    нажатия кнопки); Target — тот же строковый идентификатор JS-цели.
    api-metrika.yandex.net — обычный certifi-контекст.
    """
    if not METRIKA_COUNTER_ID or not METRIKA_OAUTH_TOKEN or METRIKA_CLIENT is None:
        return False
    csv_body = f"ClientId,Target,DateTime\n{cid},{goal},{int(time.time())}\n"
    url = (
        "https://api-metrika.yandex.net/management/v1/counter/"
        f"{METRIKA_COUNTER_ID}/offline_conversions/upload"
    )
    try:
        resp = await METRIKA_CLIENT.post(
            url,
            params={"comment": f"leadbot {goal}"},
            headers={"Authorization": f"OAuth {METRIKA_OAUTH_TOKEN}"},
            files={"file": ("conversions.csv", csv_body, "text/csv")},
        )
        if resp.status_code == 200:
            upload_id = ((resp.json().get("uploading") or {}).get("id"))
            log.info(
                "Офлайн-конверсия %s загружена (cid=%s, uploading_id=%s)",
                goal, cid, upload_id,
            )
            return True
        log.warning("Офлайн-конверсия %s: HTTP %s %s", goal, resp.status_code, resp.text[:200])
    except Exception as exc:
        log.warning("Не удалось загрузить офлайн-конверсию %s: %s", goal, exc)
    return False


async def send_metrika_goal(
    goal: str, cid: str, dedup_key: str, yclid: str = "", offline: bool = False
) -> None:
    """Server-side цель. Fire-and-forget.

    offline=True (квал-кнопки) → Offline Conversions при заданном
    METRIKA_OAUTH_TOKEN (квалификация случается через часы/дни — MP-окна в
    12 часов не хватает), фолбэк — MP. offline=False (lead_flushed) → MP.
    """
    if not METRIKA_COUNTER_ID:
        return
    if (dedup_key, goal) in _sent_conversions:
        return
    if not _METRIKA_CID_RE.match(cid or ""):
        log.info("Цель %s пропущена: нет валидного client_id", goal)
        return

    ok = (
        await _offline_upload(goal, cid)
        if offline and METRIKA_OAUTH_TOKEN
        else await _mp_collect(goal, cid, yclid)
    )
    if ok:
        _sent_conversions.add((dedup_key, goal))


# ─── Доставка карточки в группу (фон, ретраи) ────────────────────────────────
# Реестр доставленных карточек: lead_id → mid. Нужен для stage='updated'
# (клиент дожал «Отправить» после авто-флаша — правим карточку, а не шлём
# вторую, как в Telegram-боте). В памяти процесса: после рестарта дополнение
# придёт отдельной карточкой «Дополнение к заявке» — лид не теряется.
_lead_cards: OrderedDict[str, str] = OrderedDict()
_LEAD_CARDS_LIMIT = 500


def _remember_lead_card(lead_id: str, mid: str) -> None:
    if not lead_id or not mid:
        return
    outbox_drop(lead_id)  # карточка в чате — из очереди повторов убираем
    _lead_cards[lead_id] = mid
    _lead_cards.move_to_end(lead_id)
    while len(_lead_cards) > _LEAD_CARDS_LIMIT:
        _lead_cards.popitem(last=False)


async def _try_update_card(
    api: MaxClient, data: dict, attachments: list[dict], attach_note: str | None
) -> bool:
    """stage='updated': довести отправленную карточку до полной версии.

    Правим текст (без заголовка «Дополнение» — карточка должна выглядеть так,
    будто клиент сразу всё заполнил) и шлём реплаем короткое уведомление.
    False — карточку не помним (рестарт) или правка не прошла: вызывающий
    отправит отдельную карточку «Дополнение к заявке».
    """
    lead_id = str(data.get("lead_id") or "")
    mid = _lead_cards.get(lead_id)
    if not mid:
        return False

    clean = {k: v for k, v in data.items() if k != "stage"}
    text = format_lead(clean, attach_note)
    try:
        await api.edit_message(mid, text, attachments)
    except Exception as exc:
        log.warning("Правка карточки не удалась (lead_id=%s, mid=%s): %s", lead_id, mid, exc)
        return False

    _cache_card(mid, text, attachments)
    try:
        await api.send_message(
            MAX_CHAT_ID,
            "📝 <i>Клиент дополнил заявку — карточка выше обновлена</i>",
            link={"type": "reply", "mid": mid},
        )
    except Exception as exc:
        log.warning("Уведомление о дополнении не доставлено (lead_id=%s): %s", lead_id, exc)
    return True


async def deliver_lead(data: dict) -> None:
    """Заливает вложения, шлёт карточку с кнопками; 5 попыток с паузами.

    Работает в фоне (см. handle_notify) — сайт не ждёт медленный MAX.
    """
    api = API
    if api is None:  # защитный случай: notify отвечает 503 раньше
        return
    lead_id = data.get("lead_id")

    # Вложения заливаем один раз, до цикла ретраев отправки сообщения.
    try:
        file_attachments, attach_note = await upload_lead_attachments(api, data)
    except Exception as exc:
        log.warning("Заливка вложений упала (lead_id=%s): %s", lead_id, exc)
        file_attachments, attach_note = [], "📎 файл недоступен"

    text = format_lead(data, attach_note)
    attachments = [*file_attachments, status_keyboard()]

    # Дополнение уже отправленного лида: правим карточку вместо новой.
    if data.get("stage") == "updated":
        if await _try_update_card(api, data, attachments, attach_note):
            STATS["sent"] = int(STATS["sent"]) + 1  # type: ignore[arg-type]
            STATS["last_sent_at"] = datetime.now(MSK).isoformat(timespec="seconds")
            log.info("Лид дополнен (правка карточки, lead_id=%s)", lead_id)
            return

    for attempt in range(1, DELIVERY_ATTEMPTS + 1):
        try:
            result = await api.send_message(MAX_CHAT_ID, text, attachments)
            STATS["sent"] = int(STATS["sent"]) + 1  # type: ignore[arg-type]
            STATS["last_sent_at"] = datetime.now(MSK).isoformat(timespec="seconds")
            mid = str(((result.get("message") or {}).get("body") or {}).get("mid") or "")
            _cache_card(mid, text, attachments)
            _remember_lead_card(str(lead_id or ""), mid)
            log.info(
                "Лид доставлен в группу (lead_id=%s, mid=%s, попытка %d/%d)",
                lead_id, mid or "?", attempt, DELIVERY_ATTEMPTS,
            )
            # flushed-карточка доставлена → фиксируем воронку «ушёл по таймауту».
            if data.get("stage") == "flushed":
                await send_metrika_goal(
                    "lead_flushed",
                    str(data.get("client_id") or "").strip(),
                    dedup_key=f"lead:{lead_id}",
                    yclid=str(data.get("yclid") or "").strip(),
                )
            return
        except MaxApiError as exc:
            # Фолбэк: вложения так и не «дозрели» / отвергнуты — шлём без них.
            if attachments != [status_keyboard()] and "attachment" in exc.body:
                log.warning(
                    "Вложения отвергнуты (lead_id=%s): %s — шлём карточку без них",
                    lead_id, exc,
                )
                text = format_lead(data, "📎 файл недоступен" if file_attachments else attach_note)
                attachments = [status_keyboard()]
                continue
            log.warning(
                "Отправка в группу не удалась (lead_id=%s, попытка %d/%d): %s",
                lead_id, attempt, DELIVERY_ATTEMPTS, exc,
            )
        except Exception as exc:
            # Тип обязателен: у asyncio.TimeoutError пустой str(), и без него
            # причина падения выглядит в логах как пустая строка.
            log.warning(
                "Отправка в группу не удалась (lead_id=%s, попытка %d/%d): %s: %s",
                lead_id, attempt, DELIVERY_ATTEMPTS, type(exc).__name__, exc or "—",
            )
        if attempt < DELIVERY_ATTEMPTS:
            await asyncio.sleep(DELIVERY_BACKOFF[min(attempt - 1, len(DELIVERY_BACKOFF) - 1)])

    STATS["failed"] = int(STATS["failed"]) + 1  # type: ignore[arg-type]
    STATS["last_error"] = f"lead_id={lead_id}: не доставлено за {DELIVERY_ATTEMPTS} попыток"
    log.error(
        "Лид НЕ доставлен в группу (lead_id=%s) — попытки исчерпаны, откладываю в очередь",
        lead_id,
    )
    outbox_put(data)  # заявка не теряется: повторим фоном (outbox_retry_loop)


# ─── Очередь недоставленных и связь с соседним ботом ─────────────────────────
def _outbox_dir() -> Path | None:
    if not DATA_DIR:
        return None
    d = Path(DATA_DIR) / "outbox" / "max"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        log.error("Не удалось создать каталог очереди %s: %s", d, exc)
        return None
    return d


def outbox_put(payload: dict) -> None:
    """Отложить недоставленную заявку: имя файла — lead_id, повтор перезапишет."""
    d = _outbox_dir()
    lead_id = str(payload.get("lead_id") or "")
    if d is None or not lead_id:
        log.error("Заявка не доставлена и НЕ отложена (lead_id=%s, DATA_DIR=%r)", lead_id, DATA_DIR)
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
    d = _outbox_dir()
    if d is None or not lead_id:
        return
    try:
        (d / f"{lead_id}.json").unlink(missing_ok=True)
    except Exception as exc:
        log.warning("Не удалось убрать из очереди (lead_id=%s): %s", lead_id, exc)


def outbox_pending() -> int:
    d = _outbox_dir()
    if d is None:
        return 0
    try:
        return len(list(d.glob("*.json")))
    except Exception:
        return 0


async def outbox_retry_loop() -> None:
    """Фоновый повтор недоставленных заявок (см. комментарий у OUTBOX_*)."""
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
                    "Заявка в очереди больше %d ч (lead_id=%s) — прекращаю попытки",
                    OUTBOX_GIVE_UP_HOURS, lead_id,
                )
                try:
                    f.rename(f.with_suffix(".stale"))
                except Exception:
                    pass
                continue
            log.info("Повтор доставки (lead_id=%s, в очереди %.1f ч)", lead_id, age_h)
            await deliver_lead(payload)


async def notify_peer_status(lead_id: str, label: str, by: str) -> None:
    """Сообщить Telegram-боту о нажатом статусе. Fire-and-forget."""
    if not PEER_STATUS_URL or not lead_id:
        return
    payload = {
        "lead_id": lead_id,
        "label": label,
        "by": by,
        "at": datetime.now(MSK).strftime("%d.%m %H:%M"),
        "from": "MAX",
    }
    headers = {"Content-Type": "application/json"}
    if NOTIFY_SECRET:
        headers["X-Bot-Secret"] = NOTIFY_SECRET
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.post(PEER_STATUS_URL, json=payload, headers=headers)
            if resp.status_code >= 400:
                log.warning("Статус соседу не принят: HTTP %s", resp.status_code)
            else:
                log.info("Статус «%s» отправлен соседнему боту (lead_id=%s)", label, lead_id)
    except Exception as exc:
        log.warning("Не удалось сообщить статус соседу: %s: %s", type(exc).__name__, exc or "—")


async def handle_peer_status(request: web.Request) -> web.Response:
    """Telegram-бот сообщил о статусе — показываем его в MAX реплаем."""
    if NOTIFY_SECRET and request.headers.get("X-Bot-Secret", "") != NOTIFY_SECRET:
        return web.json_response({"ok": False, "error": "forbidden"}, status=403)
    api = API  # тот же глобальный клиент, что и у доставки
    if api is None:
        return web.json_response({"ok": False, "error": "no_token"}, status=503)
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad_json"}, status=400)

    lead_id = str(data.get("lead_id") or "")
    label = str(data.get("label") or "").strip()
    by = str(data.get("by") or "менеджер").strip()
    at = str(data.get("at") or datetime.now(MSK).strftime("%d.%m %H:%M"))
    source = str(data.get("from") or "Telegram")
    if not lead_id or not label:
        return web.json_response({"ok": False, "error": "bad_request"}, status=400)
    mid = _lead_cards.get(lead_id)
    if not mid:
        log.info("Статус от соседа: карточка не найдена (lead_id=%s)", lead_id)
        return web.json_response({"ok": True, "updated": False})

    text = f"{FOOTER_SEP}\n<b>{esc(label)}</b> · {esc(by)} · {at} · из {esc(source)}"
    try:
        await api.send_message(MAX_CHAT_ID, text, link={"type": "reply", "mid": mid})
        log.info("Статус «%s» из %s отражён в MAX (lead_id=%s)", label, source, lead_id)
        return web.json_response({"ok": True, "updated": True})
    except Exception as exc:
        log.warning("Не удалось отразить статус соседа: %s: %s", type(exc).__name__, exc or "—")
        return web.json_response({"ok": False, "error": "send_failed"}, status=500)


# ─── Обработка callback-кнопок ───────────────────────────────────────────────
def _strip_footer(text: str) -> str:
    """Срезает прошлый футер статуса (перещёлкивание статуса разрешено)."""
    idx = text.find(FOOTER_SEP)
    if idx != -1:
        return text[:idx].rstrip()
    return text


def _user_display_name(user: dict) -> str:
    """Имя нажавшего из объекта User MAX."""
    name = str(user.get("name") or "").strip()
    if name:
        return name
    parts = [str(user.get("first_name") or ""), str(user.get("last_name") or "")]
    name = " ".join(p for p in parts if p).strip()
    return name or "менеджер"


async def handle_callback(update: dict) -> None:
    """Нажатие ✅/🔝/❌: атомарная замена карточки + цель в Метрику."""
    api = API
    if api is None:
        return
    callback = update.get("callback") or {}
    callback_id = str(callback.get("callback_id") or "")
    payload = str(callback.get("payload") or "")
    if not payload.startswith("lead:") or not callback_id:
        return
    key = payload.split(":", 1)[1]
    label = STATUS_LABELS.get(key)
    if not label:
        return

    STATS["callbacks"] = int(STATS["callbacks"]) + 1  # type: ignore[arg-type]
    message = update.get("message") or {}
    body = message.get("body") or {}
    mid = str(body.get("mid") or "")
    plain_text = str(body.get("text") or "")
    user = _user_display_name(callback.get("user") or {})
    now = datetime.now(MSK).strftime("%d.%m %H:%M")
    footer = f"\n\n{FOOTER_SEP}\n<b>{esc(label)}</b> · {esc(user)} · {now}"

    # Исходный HTML берём из кэша; после рестарта бота его нет — работаем с
    # plain-текстом из update (экранируем, разметка карточки при этом теряется).
    cached = _CARD_CACHE.get(mid)
    if cached:
        base = _strip_footer(cached["text"])
        attachments = cached["attachments"]
    else:
        base = _strip_footer(esc(plain_text))
        # Пересобираем вложения из тела сообщения: фото/файлы по их токенам,
        # клавиатуру — свою (замена через /answers перезаписывает ВСЁ сообщение).
        attachments = []
        for att in body.get("attachments") or []:
            if not isinstance(att, dict):
                continue
            att_type = att.get("type")
            token = (att.get("payload") or {}).get("token")
            if att_type in ("image", "file", "video", "audio") and token:
                attachments.append({"type": att_type, "payload": {"token": token}})
        attachments.append(status_keyboard())

    # Лимит 4000 с учётом футера.
    if len(base) + len(footer) > MAX_TEXT_LIMIT:
        base = base[: MAX_TEXT_LIMIT - len(footer) - 1] + "…"
    new_text = base + footer

    # Окно редактирования 24 ч: старой карточке отвечаем реплаем.
    msg_ts_ms = message.get("timestamp") or 0
    too_old = bool(msg_ts_ms) and (time.time() - msg_ts_ms / 1000) > EDIT_WINDOW_SECONDS

    replaced = False
    if not too_old:
        try:
            await api.answer_callback(
                callback_id,
                message={"text": new_text, "format": "html", "attachments": attachments},
            )
            _cache_card(mid, new_text, attachments)
            replaced = True
        except Exception as exc:
            log.warning("Замена карточки не удалась (mid=%s): %s", mid, exc)

    if not replaced:
        # Карточка старше суток (или замена упала) — реплай со статусом.
        try:
            await api.answer_callback(callback_id, notification=label)
        except Exception as exc:
            log.info("Тост на callback не доставлен: %s", exc)
        chat_id = str((message.get("recipient") or {}).get("chat_id") or MAX_CHAT_ID)
        reply_text = f"{FOOTER_SEP}\n<b>{esc(label)}</b> · {esc(user)} · {now}"
        link = {"type": "reply", "mid": mid} if mid else None
        try:
            await api.send_message(chat_id, reply_text, link=link)
        except Exception as exc:
            log.warning("Реплай со статусом не доставлен (mid=%s): %s", mid, exc)

    # Сосед показывает ту же заявку — пусть отметит статус у себя.
    lead_for_peer = ""
    for lid, known_mid in _lead_cards.items():
        if known_mid == mid:
            lead_for_peer = lid
            break
    if lead_for_peer:
        await notify_peer_status(lead_for_peer, label, user)

    # Server-side цель Метрики: client_id парсим из текста карточки.
    goal = STAGE_GOALS.get(key)
    if goal:
        card_text = plain_text or base
        await send_metrika_goal(
            goal,
            _extract_field(card_text, "client_id"),
            dedup_key=f"mid:{mid}",
            yclid=_extract_field(card_text, "yclid"),
            offline=True,
        )


# ─── Ловля chat_id группы (GET /chats deprecated) ────────────────────────────
def _log_chat_hint(chat_id: object, origin: str) -> None:
    """Логирует chat_id группы и подсказывает вписать его в env."""
    if not chat_id:
        return
    if str(chat_id) == MAX_CHAT_ID:
        return
    log.info(
        "Обнаружен chat_id группы: %s (событие %s). Впишите его в MAX_CHAT_ID "
        "в env сервиса max-bot и перезапустите.",
        chat_id, origin,
    )


async def handle_update(update: dict) -> None:
    """Разбор одного update из long polling."""
    utype = update.get("update_type")
    if utype == "message_callback":
        await handle_callback(update)
    elif utype == "bot_added":
        # Бот добавлен в чат — самый надёжный способ узнать chat_id группы.
        _log_chat_hint(update.get("chat_id"), "bot_added")
    elif utype == "message_created":
        recipient = (update.get("message") or {}).get("recipient") or {}
        if recipient.get("chat_id"):
            _log_chat_hint(recipient.get("chat_id"), "message_created")
    elif utype == "bot_started":
        log.info("Пользователь запустил бота (bot_started)")


async def poll_updates() -> None:
    """Фоновый long polling GET /updates (нет webhook-подписки — он работает).

    Нужен для callback-кнопок и ловли chat_id. Чтобы получать события из
    ГРУППОВОГО чата, бот должен быть администратором чата.
    """
    api = API
    if api is None:
        return
    marker: int | None = None
    log.info("Long polling запущен")
    while True:
        try:
            data = await api.get_updates(marker)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("Long polling: %s — пауза 5 c", exc)
            await asyncio.sleep(5)
            continue
        for update in data.get("updates") or []:
            try:
                await handle_update(update)
            except Exception as exc:
                log.exception("Ошибка обработки update: %s", exc)
        if data.get("marker") is not None:
            marker = data["marker"]


# ─── HTTP-приёмник лидов ─────────────────────────────────────────────────────
async def handle_notify(request: web.Request) -> web.Response:
    """POST /notify — лид от сайта (спека §2.2). Мгновенный ack, доставка в фоне."""
    # 0. Без токена бот мирно спит: не 500 и не падение — осмысленный 503.
    if not MAX_TOKEN or API is None:
        return web.json_response({"ok": False, "error": "max_token_not_set"}, status=503)

    # 1. Аутентификация по общему секрету.
    if NOTIFY_SECRET and request.headers.get("X-Bot-Secret", "") != NOTIFY_SECRET:
        return web.json_response({"ok": False, "error": "forbidden"}, status=403)

    # 2. Группа должна быть настроена.
    if not MAX_CHAT_ID:
        log.error("Пришёл лид, но MAX_CHAT_ID не задан — некуда слать.")
        return web.json_response(
            {"ok": False, "error": "chat_not_configured"}, status=503
        )

    # 3. Тело.
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad_json"}, status=400)
    if not isinstance(data, dict):
        return web.json_response({"ok": False, "error": "bad_json"}, status=400)

    # 4. Доставка — В ФОНЕ с ретраями (5 × 2/4/8/16 c). Сразу отвечаем 200:
    #    лид на сайте уже сохранён в leads.jsonl, сайт не должен ждать MAX.
    STATS["received"] = int(STATS["received"]) + 1  # type: ignore[arg-type]
    task = asyncio.create_task(deliver_lead(data))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)

    return web.json_response({"ok": True, "queued": True})


async def handle_health(request: web.Request) -> web.Response:
    """GET /health — состояние бота (живёт и без токена)."""
    payload: dict[str, object] = {
        "ok": True,
        "service": "max-lead-bot",
        "mode": "active" if MAX_TOKEN else "waiting_for_token",
        "uptime_seconds": int(time.time() - STARTED_AT),
        "chat_configured": bool(MAX_CHAT_ID),
        "pending_delivery": len(_bg_tasks),
        "outbox_pending": outbox_pending(),
        "leads": {
            "received": STATS["received"],
            "sent": STATS["sent"],
            "failed": STATS["failed"],
        },
        "callbacks": STATS["callbacks"],
        "last_sent_at": STATS["last_sent_at"],
        "last_error": STATS["last_error"],
    }
    if not MAX_TOKEN:
        payload["waiting_for"] = "MAX_TOKEN"
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
        "Конфиг max-bot: MAX_TOKEN %s · MAX_CHAT_ID %s · порт %s:%s · API %s · "
        "NOTIFY_SECRET %s · DATA_DIR %s · METRIKA_COUNTER_ID %s · MP-токен %s · OAuth %s",
        mark(MAX_TOKEN),
        MAX_CHAT_ID or "— НЕ ЗАДАН",
        NOTIFY_HOST, NOTIFY_PORT,
        MAX_API_BASE,
        mark(NOTIFY_SECRET),
        DATA_DIR or "— НЕ ЗАДАН (вложения не уйдут)",
        METRIKA_COUNTER_ID or "—",
        mark(METRIKA_MP_TOKEN),
        mark(METRIKA_OAUTH_TOKEN),
    )


async def main() -> None:
    global API, METRIKA_CLIENT

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log_config()

    # HTTP-приёмник поднимаем ВСЕГДА — даже без токена (/health для Freim Deploy).
    app = web.Application()
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

    polling_task: asyncio.Task | None = None
    outbox_task: asyncio.Task | None = None
    if MAX_TOKEN:
        API = MaxClient(MAX_TOKEN, build_max_ssl_context())
        METRIKA_CLIENT = httpx.AsyncClient(
            verify=build_default_ssl_context(),
            timeout=httpx.Timeout(5.0, connect=5.0),
        )
        polling_task = asyncio.create_task(poll_updates())
        # Повтор недоставленных заявок. Ссылку держим отдельно от _bg_tasks:
        # там доставки, которых ждут при остановке, а этот цикл бесконечный.
        outbox_task = asyncio.create_task(outbox_retry_loop())
        pending = outbox_pending()
        if pending:
            log.warning("В очереди повторов уже лежит заявок: %d", pending)
        log.info(
            "Режим active. Группа: %s",
            MAX_CHAT_ID or "НЕ ЗАДАНА — добавьте бота админом в группу и "
            "смотрите chat_id в логах (событие bot_added)",
        )
    else:
        # КРИТИЧНО: без токена НЕ падаем (Freim Deploy-worker: crashloop завалил
        # бы деплой всего релиза). Мирно спим, /health отвечает waiting_for_token.
        log.warning(
            "MAX_TOKEN не задан — бот мирно спит (mode=waiting_for_token). "
            "Получите токен в кабинете dev.max.ru, впишите в env и перезапустите."
        )

    # Живём до SIGTERM/SIGINT (systemd stop / Ctrl+C).
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # не-Unix — не наш случай, но не падаем
            pass

    try:
        await stop.wait()
    finally:
        log.info("Остановка…")
        if polling_task is not None:
            polling_task.cancel()
            try:
                await polling_task
            except (asyncio.CancelledError, Exception):
                pass
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
        if API is not None:
            await API.close()
        if METRIKA_CLIENT is not None:
            await METRIKA_CLIENT.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except SystemExit as exc:
        # SystemExit НЕ глотаем (правка 2026-08-14). Раньше здесь стоял
        # `except (KeyboardInterrupt, SystemExit): pass`, и фатальная ошибка
        # старта (например, занятый порт) превращалась в тихий выход с кодом 0:
        # в панели «сервис не поднялся», а в журнале — ни одной строки почему.
        if exc.code not in (None, 0):
            log.error("Остановка: %s", exc)
        raise
