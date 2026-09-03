/**
 * ============================================================================
 *  lead-server/leads.ts — серверное ядро лид-пайплайна v2 (только API-роуты).
 * ----------------------------------------------------------------------------
 *  Поток: шаг 1 формы → POST /api/lead/draft → черновик на диске + таймер;
 *  шаг 2 / попап → POST /api/lead/complete → merge → notify ботам (fan-out).
 *  Черновики, до которых не дошёл complete, отправляет ботам ФЛАШЕР —
 *  отдельный модуль server/lead-flusher.mjs, живущий в том же node-процессе
 *  (подключается на старте через `node --import`). Этот файл флашером НЕ
 *  занимается — только пишет черновики в том формате, который флашер читает
 *  (контракт ниже).
 *
 *  Хранилище (DATA_DIR = env LEAD_DATA_DIR, дефолт ./data для дев-режима):
 *    leads.jsonl                — append-only журнал ВСЕХ событий (persist
 *                                 обязателен: провал = 500, заявка не принята)
 *    drafts/<lead_id>.json      — активный черновик:
 *                                 { lead, due_at: ISO, attempts: number }
 *    drafts/sent/<lead_id>.json — лид ушёл ботам (дедуп повторного complete)
 *    drafts/failed/…            — флашер исчерпал попытки (лид ЖИВ в jsonl)
 *    attachments/<lead_id>/N.ext
 *
 *  Принципы: persist обязателен, notify — нет; honeypot возвращает фейковый
 *  успех; идемпотентность по lead_id (повторный draft — upsert, повторный
 *  complete без новых данных — 201 без действий).
 * ============================================================================
 */
import { z } from 'zod';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SITE } from '../../config/site';
import { MAX_FILES, MAX_FILE_SIZE } from '../lead-attachments';

// ── Конфиг ──────────────────────────────────────────────────────────────────
export const DATA_DIR = process.env.LEAD_DATA_DIR || path.resolve('data');
const DRAFTS_DIR = path.join(DATA_DIR, 'drafts');
const SENT_DIR = path.join(DRAFTS_DIR, 'sent');
const FAILED_DIR = path.join(DRAFTS_DIR, 'failed');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
/**
 * Карантин honeypot: заявки, где заполнено скрытое поле-ловушка. Их НЕ видят
 * менеджеры, но и не теряем — лежат файлами, пока их не уберёт флашер по TTL
 * (LEAD_QUARANTINE_TTL_DAYS). Так ловушка перестаёт быть смертельной: если она
 * снова поймает живого человека (21.08.2026 автозаполнение браузера
 * заполняло поле «Компания» у реальных людей, и заявки исчезали), запись
 * останется на диске и её можно достать.
 */
const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');
/**
 * Очередь повторной отправки ботам: `notify-retry/<slug адреса>/<lead_id>.json`.
 *
 * Зачем: `notifyBots` — fire-and-forget, и бот, который в этот момент лежит,
 * заявку просто НЕ получал. Его собственная очередь тут не поможет — она
 * спасает уже принятое. А лежит бот предсказуемо: Freim Deploy на каждом
 * редеплое перезапускает воркеры по очереди, и заявка, пришедшая в это окно,
 * ушла бы только тому боту, который успел подняться. Ровно так 22.08.2026
 * лид попал в MAX и не попал в Telegram.
 *
 * Разбор по адресам, а не одной кучей: упасть может любой один, и повторять
 * нужно только ему — иначе поднявшийся бот получит карточку второй раз.
 */
const NOTIFY_RETRY_DIR = path.join(DATA_DIR, 'notify-retry');
const JSONL = path.join(DATA_DIR, 'leads.jsonl');

const FLUSH_MINUTES = Number(process.env.LEAD_FLUSH_MINUTES || 15);
const NOTIFY_URLS = (process.env.LEAD_NOTIFY_URLS || '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
const NOTIFY_SECRET = process.env.LEAD_NOTIFY_SECRET || '';

function ensureDirs(): void {
  for (const dir of [DATA_DIR, DRAFTS_DIR, SENT_DIR, FAILED_DIR, ATTACH_DIR, QUARANTINE_DIR, NOTIFY_RETRY_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ── Rate limit: 10 req / мин / IP (in-memory) ───────────────────────────────
const RATE_LIMIT = 10;
const RATE_WINDOW = 60_000;
const hits = new Map<string, number[]>();

export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW);
  if (recent.length >= RATE_LIMIT) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

export function clientIp(request: Request, fallback?: string): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return fallback || 'unknown';
}

// ── Origin allowlist (как contact.ts.example) ───────────────────────────────
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true; // Safari не шлёт Origin на same-origin no-JS POST
  try {
    const url = new URL(origin);
    // В dev-режиме принимаем любой localhost-порт (astro dev/preview меняют порты).
    if (import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(url.hostname)) return true;
    const site = new URL(SITE.url);
    return url.origin === site.origin || url.origin === site.origin.replace('://', '://www.');
  } catch {
    return false;
  }
}

// ── Антибот: запрос пришёл не из браузера ───────────────────────────────────
/**
 * Honeypot ловит только тех ботов, которые РЕНДЕРЯТ форму: поле `hp_token`
 * существует лишь в разметке страницы. Спамер, который бьёт прямо в
 * `/api/lead/complete/`, страницы не открывает, ловушки не видит и присылает
 * тело, неотличимое от честного.
 *
 * ПОДТВЕРЖДЕНО ЛОГАМИ (creative-solution.ru, разбор 29.08.2026). Реклама
 * казино, дошедшая до чата менеджеров, выглядела так:
 *
 *     POST /api/lead/complete/
 *     Content-Type: application/x-www-form-urlencoded
 *     Origin:          —              User-Agent: Chrome/129 (подделан)
 *     Sec-Fetch-Site:  —
 *
 * Бот скачал HTML, разобрал форму и отправил ВСЕ её поля: скрытые зеркала
 * (`page_url`, `client_id`, `utm_*`) приехали пустыми строками — их
 * заполняет lead-form.ts, который у бота не выполнялся, — а `hp_token` он
 * оставил пустым, поэтому ловушка честно промолчала.
 *
 * ПРИЗНАК. `Origin` и `Sec-Fetch-Site` браузер проставляет САМ: это
 * forbidden headers, страница их не переопределит. Живой посетитель шлёт
 * хотя бы один из них, автомат — ни одного. Разбор боевых POST в
 * `/api/lead/*`:
 *
 *     json + Origin + Sec-Fetch   21  живые заявки
 *     json + Origin, без Sec-Fetch 1  живая заявка (Safari до 16.4)
 *     без Origin и без Sec-Fetch   4  боты (в т.ч. тот самый спам)
 *
 * Поэтому НЕ требуем `Sec-Fetch-*` отдельно (Safari до 16.4 его не слал —
 * и в выборке такой человек есть) и не смотрим на Content-Type: первая
 * версия этой проверки ловила только «JSON без Origin» и тот самый спам,
 * пришедший form-encoded, пропустила бы.
 *
 * Фильтра по СОДЕРЖИМОМУ полей здесь сознательно нет: поле свободного текста
 * само просит ссылку на текущий сайт, и эвристика по тексту рискует молча
 * съесть живую заявку — цена ошибки несимметрична.
 *
 * Возвращаем признак, а не отказ: решение «в карантин, а не 403» принято
 * осознанно — заявка ложится на диск и её можно достать, если признак
 * когда-нибудь поймает живого человека (ровно так уже было с honeypot
 * 21.08.2026).
 */
export function looksAutomated(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');

  // Браузер сам сказал, что отправку инициировала чужая страница.
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;

  // Sec-Fetch-* приезжают СЕМЬЁЙ: браузер, который умеет Fetch Metadata,
  // ставит Site вместе с Mode и Dest — послать один без Site он не может.
  // Подделыватель заголовков про это не знает и копирует горстку «похожих
  // на браузерные»: спам 03.09.2026 на втором боевом проекте пришёл с
  // `Sec-Fetch-Mode: cors`, но БЕЗ `Sec-Fetch-Site` (лог Caddy, см. §5
  // рецепта). Живых заявок с таким набором в журналах проектов нет.
  if (!fetchSite && (request.headers.get('sec-fetch-mode') || request.headers.get('sec-fetch-dest')))
    return true;

  // Ни одного заголовка, который браузер проставляет сам, — значит не браузер.
  return !fetchSite && !request.headers.get('origin');
}

// ── Антибот: страница не выполнялась ────────────────────────────────────────
/**
 * Третий эшелон, признак в ТЕЛЕ запроса — на случай, когда заголовки
 * подделаны убедительно.
 *
 * ПОДТВЕРЖДЕНО ЖУРНАЛОМ (второй боевой проект, разбор 03.09.2026). Спам, дошедший
 * до чата менеджеров в 03:36 UTC, лёг в `leads.jsonl` так:
 *
 *     phone "+77071859600"  name "Роман"  source "form"
 *     page_url ""  client_id ""  utm_* ""  prefill ""  case ""
 *
 * Все скрытые поля формы приехали ПУСТЫМИ строками — ровно в том виде, в
 * каком они лежат в разметке (`value=""`). Заполняет их наш `lead-form.ts`:
 * `baseBody()` кладёт `page_url: window.location.href` в JSON-тело, а
 * `enhance()` через `setHidden()` — в те же скрытые поля для no-JS сабмита.
 * Пустой `page_url` означает, что НАШ КОД НЕ ВЫПОЛНЯЛСЯ НИ РАЗУ: страницу
 * не открывали, форму разобрали из скачанного HTML.
 *
 * ВЫБОРКА. Боевые журналы двух проектов на 03.09.2026:
 *
 *     проект Б                56 живых с адресом,  2 бота с ""
 *     creative-solution.ru    8 живых с адресом,  1 бот с ""
 *
 * Ложных срабатываний на всей истории — 0.
 *
 * Это НЕ фильтр по содержимому: мы не читаем, ЧТО написано в полях, и не
 * ищем стоп-слов (запрет из §5 рецепта в силе). Мы проверяем ровно один
 * факт — отработал ли наш собственный клиентский код.
 *
 * ГРАНИЦА ПРИМЕНИМОСТИ. Признак не увидит бота на headless-браузере: там
 * страница выполняется по-настоящему и `page_url` будет заполнен. Против
 * такого нужен подписанный токен от сервера, а не эвристика.
 *
 * ЧЕМ РИСКУЕМ. Живой человек с полностью отключённым JS отправит форму
 * нативным POST'ом, и `page_url` у него тоже будет пуст. Поэтому здесь, как
 * и в двух эшелонах выше, карантин, а не отказ: заявка ложится на диск,
 * всплеск виден в `/api/health`, номер можно достать и перезвонить.
 *
 * ⚠️ ПЕРЕД ВКЛЮЧЕНИЕМ НА НОВОМ ПРОЕКТЕ убедитесь, что форма проекта шлёт
 * `page_url` на ВСЕХ путях отправки (в шаблоне это `baseBody()` +
 * `enhance()/setHidden()` в `lead-form.ts`). Форма, которая его не шлёт,
 * уедет в карантин целиком.
 */
export function noPageProof(raw: Record<string, unknown>): boolean {
  return !String(raw.page_url ?? '').trim();
}

// ── Валидация ───────────────────────────────────────────────────────────────
const phoneField = z
  .string()
  .transform((v) => v.replace(/[^\d+]/g, ''))
  .refine((v) => /^\+?[78]?\d{10}$/.test(v.replace(/^\+/, '')), {
    message: 'Некорректный номер телефона',
  });

/** Общие поля обоих запросов (шаг 1 и полная заявка). */
const baseFields = {
  lead_id: z.string().uuid().optional(),
  phone: phoneField,
  name: z.string().trim().max(200).optional(),
  consent: z.coerce.boolean().optional(),
  source: z.string().max(100).optional().default('form'),
  page_url: z.string().max(2000).optional(),
  client_id: z.string().max(100).optional(),
  utm_source: z.string().max(200).optional(),
  utm_medium: z.string().max(200).optional(),
  utm_campaign: z.string().max(200).optional(),
  utm_term: z.string().max(500).optional(),
  utm_content: z.string().max(500).optional(),
  yclid: z.string().max(100).optional(),
  gclid: z.string().max(100).optional(),
};

export const draftSchema = z.object(baseFields);

export const completeSchema = z.object({
  ...baseFields,
  // ── Поля шага 2 — расширяйте/сокращайте под проект (зеркально STEP2_FIELDS
  //    в lead-form.ts) ──
  type: z.string().max(100).optional(),
  message: z.string().trim().max(5000).optional(),
  contactMethod: z.enum(['phone', 'messenger']).optional(),
  prefill: z.string().max(200).optional(),
  case: z.string().max(300).optional(),
  config: z.string().trim().max(500).optional(),
});

export type LeadFields = z.infer<typeof completeSchema> & {
  lead_id: string;
  created_at?: string;
  completed_at?: string | null;
  /** Проставляется при позднем complete (дополнение уже отправленного лида). */
  updated_at?: string;
  attachments?: AttachmentMeta[];
};

/** Результат completeLead: сам лид + был ли он уже отправлен ботам раньше
 *  (updated=true — это ДОПОЛНЕНИЕ: клиент дожал «Отправить» после авто-флаша
 *  или прислал новые данные повторным сабмитом). */
export interface CompleteResult {
  lead: LeadFields;
  updated: boolean;
}

export interface AttachmentMeta {
  path: string; // относительно DATA_DIR
  name: string;
  size: number;
  mime: string;
}

// ── Вложения ────────────────────────────────────────────────────────────────
// `MAX_FILES` / `MAX_FILE_SIZE` приезжают из общего `lib/lead-attachments.ts` —
// оттуда же их берёт форма (LeadAttachments.astro). Дублировать числа здесь
// нельзя: разъехавшись, они дают самый неприятный класс багов — форма приняла
// файл, сервер молча выбросил, посетитель уверен, что прислал.

/**
 * Расширение файла на диске. Тип файла НЕ ограничиваем: посетители шлют что
 * угодно (фото с телефона в экзотических форматах, документы, архивы) — мы
 * файл не открываем и не отдаём по HTTP, только сохраняем и пересылаем в
 * мессенджер, так что белый список форматов лишь терял бы реальные заявки.
 *
 * Имя на диске собирается САМИМ сервером (`<N>.<ext>`), из пользовательского
 * имени берётся только расширение и только из безопасного алфавита — точки,
 * слэши и `..` физически не могут попасть в путь. Исходное имя сохраняется в
 * метаданных (`name`) и уходит ботам — менеджер видит настоящее имя файла,
 * а не «3.pdf».
 */
function safeExt(fileName: string): string {
  const match = (fileName || '').match(/\.([A-Za-z0-9]{1,12})$/);
  return match ? `.${match[1].toLowerCase()}` : '.bin';
}

/** Сохраняет валидные файлы из multipart, возвращает метаданные. */
export function saveAttachments(leadId: string, files: File[], buffers: Buffer[]): AttachmentMeta[] {
  ensureDirs();
  const saved: AttachmentMeta[] = [];
  const dir = path.join(ATTACH_DIR, leadId);
  files.slice(0, MAX_FILES).forEach((file, i) => {
    if (file.size > MAX_FILE_SIZE || file.size === 0) return;
    const ext = safeExt(file.name);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const rel = path.join('attachments', leadId, `${i + 1}${ext}`);
    writeFileSync(path.join(DATA_DIR, rel), buffers[i]);
    saved.push({ path: rel, name: file.name || `file${ext}`, size: file.size, mime: file.type || '' });
  });
  return saved;
}

// ── Журнал (persist обязателен) ─────────────────────────────────────────────
export function appendJournal(event: string, lead: Record<string, unknown>): void {
  ensureDirs();
  appendFileSync(JSONL, JSON.stringify({ event, at: new Date().toISOString(), ...lead }) + '\n', 'utf-8');
}

// ── Черновики ───────────────────────────────────────────────────────────────
function draftPath(id: string): string {
  return path.join(DRAFTS_DIR, `${id}.json`);
}
function sentPath(id: string): string {
  return path.join(SENT_DIR, `${id}.json`);
}

export function isAlreadySent(id: string): boolean {
  return existsSync(sentPath(id));
}

/** Upsert черновика: повторный draft с тем же lead_id обновляет поля,
 *  но сохраняет исходные created_at/due_at (таймер не сдвигается). */
export function saveDraft(lead: LeadFields): void {
  ensureDirs();
  const file = draftPath(lead.lead_id);
  let created_at = new Date().toISOString();
  let due_at = new Date(Date.now() + FLUSH_MINUTES * 60_000).toISOString();
  if (existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf-8'));
      created_at = prev.lead?.created_at ?? created_at;
      due_at = prev.due_at ?? due_at;
    } catch {
      /* битый файл — перезапишем */
    }
  }
  const record = { lead: { ...lead, created_at }, due_at, attempts: 0 };
  // Атомарно: tmp + rename, чтобы флашер не прочитал полфайла.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(tmp, file);
}

/** Merge complete-заявки с черновиком (complete побеждает), снятие с таймера.
 *
 *  Лид уже уходил ботам (авто-флаш по таймеру или прежний complete)?
 *  Поздний «Отправить» ДОСЫЛАЕТ данные: merge с отправленной версией →
 *  updated=true, боты получают stage='updated' и редактируют карточку.
 *  Если ничего нового не пришло (двойной клик, повторный сабмит той же
 *  формы) — null: карточка не задваивается.
 */
export function completeLead(lead: LeadFields): CompleteResult | null {
  ensureDirs();

  if (isAlreadySent(lead.lead_id)) {
    let prev: LeadFields | null = null;
    try {
      prev = JSON.parse(readFileSync(sentPath(lead.lead_id), 'utf-8'));
    } catch {
      /* битый sent-файл — обработка ниже */
    }
    if (prev === null) {
      // Не знаем, что уходило ботам, — перешлём пришедшую версию целиком
      // как дополнение (лучше лишняя карточка, чем потерянные детали).
      const resent: LeadFields = { ...lead, updated_at: new Date().toISOString() };
      resent.completed_at = resent.completed_at ?? resent.updated_at;
      writeFileSync(sentPath(lead.lead_id), JSON.stringify(resent, null, 2), 'utf-8');
      return { lead: resent, updated: true };
    }
    const incoming = stripEmpty(lead) as Partial<LeadFields>;
    // Времена и вложения мержатся отдельно — не считаем их «новыми данными».
    delete incoming.created_at;
    delete incoming.completed_at;
    delete incoming.updated_at;
    const prevAtt = prev.attachments ?? [];
    const newAtt = (lead.attachments ?? []).filter(
      (a) => !prevAtt.some((p) => p.path === a.path),
    );
    delete incoming.attachments;
    const changed =
      newAtt.length > 0 ||
      Object.entries(incoming).some(([k, v]) => (prev as Record<string, unknown>)[k] !== v);
    if (!changed) return null; // настоящий дубль — дедуп как раньше

    const merged: LeadFields = { ...prev, ...incoming, attachments: [...prevAtt, ...newAtt] };
    merged.updated_at = new Date().toISOString();
    merged.completed_at = merged.completed_at ?? merged.updated_at;
    writeFileSync(sentPath(lead.lead_id), JSON.stringify(merged, null, 2), 'utf-8');
    return { lead: merged, updated: true };
  }

  let merged: LeadFields = { ...lead };
  const file = draftPath(lead.lead_id);
  if (existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf-8'));
      merged = { ...prev.lead, ...stripEmpty(lead) };
    } catch {
      /* битый черновик — берём complete как есть */
    }
    try {
      unlinkSync(file);
    } catch {
      /* уже удалён — не страшно */
    }
  }
  merged.completed_at = new Date().toISOString();
  merged.created_at = merged.created_at ?? merged.completed_at;
  // Маркер «отправлено» пишем сразу: даже если notify упадёт, повторный
  // сабмит не задвоит карточку (лид уже в jsonl, боты ретраят сами).
  writeFileSync(sentPath(lead.lead_id), JSON.stringify(merged, null, 2), 'utf-8');
  return { lead: merged, updated: false };
}

function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
}

// ── Fan-out ботам (fire-and-forget из роута) ────────────────────────────────
// stage: complete — обычная полная заявка; flushed — авто-отправка черновика
// по таймеру; updated — дополнение уже отправленного лида (боты редактируют
// существующую карточку вместо новой).
export interface NotifyPayload extends LeadFields {
  stage: 'complete' | 'flushed' | 'updated';
}

/**
 * Имя каталога очереди для адреса бота. Слаг, а не сам URL: имя каталога не
 * должно зависеть от того, что в адресе есть `/` и `:`. Сам адрес хранится
 * внутри записи — повторяет по нему именно флашер.
 */
export function notifyQueueSlug(url: string): string {
  return url.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'bot';
}

/** Отложить заявку для КОНКРЕТНОГО бота, который её не принял. */
export function queueNotify(url: string, payload: NotifyPayload): void {
  ensureDirs();
  const dir = path.join(NOTIFY_RETRY_DIR, notifyQueueSlug(url));
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${payload.lead_id}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ url, queued_at: new Date().toISOString(), payload }, null, 2),
      'utf-8',
    );
    renameSync(tmp, file);
    appendJournal('notify_queued', { lead_id: payload.lead_id, url });
  } catch (err) {
    console.error(`[lead] не удалось отложить notify для ${url}:`, err);
  }
}

/** Сколько заявок ждёт повтора — уходит в /api/health. */
export function notifyQueuePending(): number {
  if (!existsSync(NOTIFY_RETRY_DIR)) return 0;
  try {
    return readdirSync(NOTIFY_RETRY_DIR).reduce((sum, slug) => {
      const dir = path.join(NOTIFY_RETRY_DIR, slug);
      try {
        return sum + readdirSync(dir).filter((f) => f.endsWith('.json')).length;
      } catch {
        return sum;
      }
    }, 0);
  } catch {
    return 0;
  }
}

/**
 * Разослать заявку ботам. Возвращает true, если принял хотя бы один.
 *
 * `queueFailures` — откладывать ли не принявших в очередь повторов. Роут
 * ставит true: черновик уже удалён, второй попытки взяться неоткуда. Флашер
 * ставит true только когда сам считает заявку доставленной, иначе повторяли
 * бы оба, и поднявшийся бот получил бы карточку дважды.
 */
export async function notifyBots(
  payload: NotifyPayload,
  { queueFailures = false }: { queueFailures?: boolean } = {},
): Promise<boolean> {
  if (NOTIFY_URLS.length === 0) {
    console.warn('[lead] LEAD_NOTIFY_URLS не задан — лид сохранён, но боты не уведомлены');
    return false;
  }
  const results = await Promise.allSettled(
    NOTIFY_URLS.map(async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(NOTIFY_SECRET ? { 'X-Bot-Secret': NOTIFY_SECRET } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return true;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const ok = results.some((r) => r.status === 'fulfilled');
  if (queueFailures) {
    results.forEach((r, i) => {
      if (r.status === 'rejected') queueNotify(NOTIFY_URLS[i], payload);
    });
  }
  if (!ok) {
    console.error(
      `[lead] notify не доставлен ни одному боту (lead_id=${payload.lead_id}):`,
      results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')).join('; '),
    );
  }
  return ok;
}

// ── Утилиты роутов ──────────────────────────────────────────────────────────
/**
 * Заявка со сработавшей ловушкой: сохраняем и НЕ отдаём ботам.
 *
 * Почему не удаляем молча (как делали до 21.08.2026): скрытое поле заполняет
 * не только робот, но и автозаполнение браузера у живого человека. Тогда
 * сервер отвечал «принято», клиент видел страницу «Спасибо», а заявка
 * исчезала — потерю не замечал никто. Теперь она лежит на диске: если
 * окажется, что поймали человека, номер можно достать и перезвонить.
 *
 * Файлы уносит флашер по LEAD_QUARANTINE_TTL_DAYS (дефолт 14 дней) —
 * персональные данные не копятся вечно.
 */
export type QuarantineReason = 'honeypot' | 'not_browser' | 'no_page_proof';

export function quarantineLead(
  lead: LeadFields,
  stage: 'draft' | 'complete',
  reason: QuarantineReason = 'honeypot',
): void {
  ensureDirs();
  const record = {
    ...lead,
    quarantined_at: new Date().toISOString(),
    stage,
    reason,
  };
  const file = path.join(QUARANTINE_DIR, `${lead.lead_id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(tmp, file);
  appendJournal('quarantined', { lead_id: lead.lead_id, stage, reason });
}

/** Сколько заявок сейчас в карантине — для /api/health, чтобы всплеск был виден. */
export function quarantineStats(): { total: number; last24h: number } {
  if (!existsSync(QUARANTINE_DIR)) return { total: 0, last24h: 0 };
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let total = 0;
  let last24h = 0;
  for (const name of readdirSync(QUARANTINE_DIR)) {
    if (!name.endsWith('.json')) continue;
    total += 1;
    try {
      if (statSync(path.join(QUARANTINE_DIR, name)).mtimeMs >= dayAgo) last24h += 1;
    } catch {
      /* файл мог исчезнуть между readdir и stat */
    }
  }
  return { total, last24h };
}

export function newLeadId(): string {
  return randomUUID();
}

export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
