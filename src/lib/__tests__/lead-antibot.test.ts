/**
 * Антибот: запрос пришёл мимо страницы (looksAutomated, lead-server/leads.ts).
 *
 * Honeypot ловит только ботов, которые рендерят форму. 28.08.2026 в чат
 * менеджеров дошла реклама казино: бот скачал HTML, разобрал форму и
 * отправил её поля напрямую — скрытое поле осталось пустым, и ловушка
 * честно промолчала. Заголовки того запроса взяты здесь эталоном (лог
 * Caddy соседнего проекта на том же стартере — creative-solution.ru).
 *
 * Кейсы «живых» ниже — не выдумка, а полная разбивка 22 настоящих заявок
 * из того же лога, включая Safari без Sec-Fetch-*. Ложное срабатывание
 * здесь тише и дороже пропущенного спама: заявка молча уедет в карантин.
 *
 * Фильтра по СОДЕРЖИМОМУ полей в пайплайне намеренно нет (решение
 * 29.08.2026): поле «о бизнесе» само просит ссылку на текущий сайт, и
 * эвристика по тексту рискует съесть живую заявку. Проверка смотрит только
 * на то, КАК пришёл запрос, и не читает, ЧТО в нём написано.
 */
import { describe, expect, it } from 'vitest';
import { looksAutomated, noPageProof } from '../lead-server/leads';

const SITE_ORIGIN = 'https://example.com';

const req = (headers: Record<string, string>): Request =>
  new Request('https://example.com/api/lead/complete/', { method: 'POST', headers });

describe('looksAutomated — боты', () => {
  it('ловит тот самый спам 28.08.2026: form-encoded, без Origin и Sec-Fetch', () => {
    expect(
      looksAutomated(
        req({
          'content-type': 'application/x-www-form-urlencoded',
          // User-Agent бот подделал под настоящий Chrome — на него не смотрим.
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        }),
      ),
    ).toBe(true);
  });

  it('ловит прямой POST JSON без заголовков (curl/requests)', () => {
    expect(looksAutomated(req({ 'content-type': 'application/json' }))).toBe(true);
  });

  it('ловит отправку с чужой страницы (sec-fetch-site: cross-site)', () => {
    expect(
      looksAutomated(
        req({
          'content-type': 'application/json',
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        }),
      ),
    ).toBe(true);
  });
});

describe('looksAutomated — живые люди (разбивка боевого лога)', () => {
  it('пропускает fetch() нашей формы — 21 из 22 заявок', () => {
    expect(
      looksAutomated(
        req({
          'content-type': 'application/json',
          origin: 'https://example.com',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(false);
  });

  it('пропускает Safari до 16.4: Origin есть, Sec-Fetch-* нет — 1 из 22', () => {
    expect(
      looksAutomated(
        req({ 'content-type': 'application/json', origin: 'https://example.com' }),
      ),
    ).toBe(false);
  });

  it('пропускает no-JS <form> POST со страницы: Origin есть, тело form-encoded', () => {
    expect(
      looksAutomated(
        req({
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://example.com',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(false);
  });

  it('пропускает отправку с вложениями (multipart из формы)', () => {
    expect(
      looksAutomated(
        req({
          'content-type': 'multipart/form-data; boundary=x',
          origin: 'https://example.com',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(false);
  });
});

/**
 * Эшелон 2, часть вторая: Sec-Fetch-* приезжают семьёй.
 *
 * Спам 03.09.2026 на втором боевом проекте (тот же стартер) прошёл первую версию
 * looksAutomated: бот подделал `Origin`, и проверка «нет ни Origin, ни
 * Sec-Fetch-Site» промолчала. Точная запись из лога Caddy — в тесте ниже.
 * Улика, которую бот не воспроизвёл: `Sec-Fetch-Mode: cors` БЕЗ
 * `Sec-Fetch-Site`. Браузер так не умеет — Fetch Metadata он ставит
 * комплектом.
 */
describe('looksAutomated — подделанные заголовки (спам 03.09.2026)', () => {
  it('ловит боевой запрос: Origin подделан, Sec-Fetch-Mode без Sec-Fetch-Site', () => {
    expect(
      looksAutomated(
        req({
          accept: 'text/html,application/json,*/*',
          'accept-encoding': 'br, gzip, deflate',
          'accept-language': 'ru-RU,ru;q=0.9',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          origin: SITE_ORIGIN,
          referer: `${SITE_ORIGIN}/`,
          'sec-fetch-mode': 'cors',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        }),
      ),
    ).toBe(true);
  });

  it('ловит Sec-Fetch-Dest без Sec-Fetch-Site (тот же почерк, другая горстка)', () => {
    expect(looksAutomated(req({ origin: SITE_ORIGIN, 'sec-fetch-dest': 'empty' }))).toBe(true);
  });

  it('НЕ трогает Safari до 16.4: Sec-Fetch-* нет вообще ни одного', () => {
    // Ключевая граница: «нет всей семьи» — легальный старый браузер,
    // «есть кусок семьи без Site» — подделка.
    expect(looksAutomated(req({ origin: SITE_ORIGIN }))).toBe(false);
  });

  it('НЕ трогает полный набор живой заявки (Site + Mode, как в логе)', () => {
    expect(
      looksAutomated(
        req({
          'content-type': 'application/json',
          origin: SITE_ORIGIN,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
        }),
      ),
    ).toBe(false);
  });
});

/**
 * Эшелон 3: страница не выполнялась. Боевые журналы на 03.09.2026 —
 * проект Б: 56 живых с адресом, 2 бота с пустым; creative-solution.ru:
 * 8 живых, 1 бот. Ложных срабатываний на всей истории — 0.
 */
describe('noPageProof — тела из боевого журнала', () => {
  it('ловит рекламу казино 28.08.2026 (creative-solution.ru): все зеркала пусты', () => {
    expect(
      noPageProof({
        phone: '87165552382',
        consent: true,
        source: 'form',
        page_url: '',
        client_id: '',
        utm_source: '',
        about: 'THE $30,000,000 JACKPOT IS A POCKETFUL OF POSSIBILITIES',
      }),
    ).toBe(true);
  });

  it('ловит спам 03.09.2026 (второй боевой проект): те же пустые строки', () => {
    expect(
      noPageProof({
        phone: '+77071859600',
        name: 'Роман',
        consent: true,
        source: 'form',
        page_url: '',
        client_id: '',
        utm_source: '',
        yclid: '',
        gclid: '',
      }),
    ).toBe(true);
  });

  it('ловит запрос вообще без page_url (бот шлёт только контакт)', () => {
    expect(noPageProof({ phone: '+79990000000' })).toBe(true);
  });

  it('пропускает живую заявку с якоря формы', () => {
    expect(
      noPageProof({
        phone: '+79952003616',
        name: 'Фаина',
        consent: true,
        source: 'calc',
        page_url: `${SITE_ORIGIN}/#calculation`,
        client_id: '1788270691756972711',
      }),
    ).toBe(false);
  });

  it('пропускает живую заявку из Директа (page_url с utm и yclid)', () => {
    expect(
      noPageProof({
        phone: '+79809061831',
        consent: true,
        source: 'calc',
        page_url: `${SITE_ORIGIN}/?utm_source=yandex&utm_medium=cpc&yclid=12587888974551318527`,
        client_id: '1788260504618892458',
      }),
    ).toBe(false);
  });

  it('пропускает живую заявку с голой главной', () => {
    expect(noPageProof({ phone: '+79990000000', page_url: `${SITE_ORIGIN}/` })).toBe(false);
  });

  it('НЕ читает содержимое полей: заявка со спам-текстом, но с page_url — пропускается', () => {
    // Запрет фильтра по содержимому (решение 29.08.2026) остаётся в силе:
    // признак смотрит только на то, отработал ли наш клиентский код.
    expect(
      noPageProof({
        phone: '+79990000000',
        message: 'Казино онлайн http://spam.example — бонус 500%',
        page_url: `${SITE_ORIGIN}/#calculation`,
      }),
    ).toBe(false);
  });
});
