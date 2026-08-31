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
import { looksAutomated } from '../lead-server/leads';

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
