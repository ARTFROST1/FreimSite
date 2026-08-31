import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ПУБЛИЧНОЕ ДЕРЕВО НЕ ВЫНОСИТ ЛИЧНОЕ.
 *
 * Этот репозиторий одновременно витрина и личный рабочий инструмент. Рецепты
 * пишутся по горячим следам сразу после клиентского сайта и естественным
 * образом называют проект по имени — без замка имя вернётся само через
 * три-четыре проекта.
 *
 * Искомые слова собираются из букв, а не хранятся строкой. Иначе этот файл сам
 * стал бы тем местом, где имя клиента опубликовано, — и заодно пережил бы
 * глобальную замену, которая переписала бы литерал вместе с кодом.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');

// Отличительный корень, а не полное написание: имя встречается в разных вариантах
// с дефисом, подчёркиванием, капсом и через пробел. Полная форма пропустила бы
// последний вариант — именно так он и утёк бы в публичный репозиторий.
const CLIENT = ['m', 'u', 'b', 'l', 'e', 's'].join('');
// Имя живёт не только транслитом: в примерах путей оно всплывает записанным
// кириллицей, тем же корнем, но другим алфавитом. Замок, знающий только одну
// азбуку, — это замок с дырой: латинский корень такую запись не увидит вовсе.
// Второй корень закрывает именно этот случай.
const CLIENT_CYR = ['м', 'у', 'б', 'л'].join('');
const HOMEDIR = ['/', 'U', 's', 'e', 'r', 's', '/'].join('');
const MAIL = ['a', 'r', 't', 'm', 'o', 'r', 'o', 'z'].join('');

// Второй клиент и третий клиент живут в дереве не корнем, а трёхбуквенными
// инициалами — короче любого разумного корня. Подстрочный поиск на них не
// годится: инициал встречается внутри base64 (package-lock.json и подобные
// генерируемые файлы), где он не слово, а случайный обрывок байт. Поэтому
// эти токены ищутся отдельным механизмом — по границам слова, — а не
// добавляются в CLIENT/CLIENT_CYR выше.
const TOKEN_SHOWCASE = ['L', 'V', 'P'].join('');
const TOKEN_CATALOG = ['F', 'N', 'O'].join('');
const TOKEN_WORD_A = ['v', 'i', 'l', 'l', 'a'].join('');
const TOKEN_WORD_B = ['p', 'i', 'n', 'e'].join('');
// Тот же урок, что и с CLIENT/CLIENT_CYR выше, но забытый при первой
// сборке токенов: замок, знающий только один алфавит, — замок с дырой.
// 'i'-флаг регэкспа не пересекает алфавиты — латинское написание не найдёт
// кириллическое. У обоих инициалов есть естественная кириллическая запись
// (те же буквы транслитерированы визуально), и её тоже нужно ловить.
const TOKEN_SHOWCASE_CYR = ['Л', 'В', 'П'].join('');
const TOKEN_CATALOG_CYR = ['Ф', 'Н', 'О'].join('');
const TOKENS = [
  TOKEN_SHOWCASE,
  TOKEN_CATALOG,
  TOKEN_WORD_A,
  TOKEN_WORD_B,
  TOKEN_SHOWCASE_CYR,
  TOKEN_CATALOG_CYR,
];

/** Бинарники не читаем: там нет текста, зато есть мегабайты. */
const BINARY = /\.(png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|mp4|webm|pdf|zip)$/i;

function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean).filter((f) => !BINARY.test(f));
}

function hits(needle: string): string[] {
  const found: string[] = [];
  const lowered = needle.toLowerCase();
  for (const file of trackedTextFiles()) {
    const body = readFileSync(path.join(ROOT, file), 'utf8');
    body.split('\n').forEach((line, i) => {
      if (line.toLowerCase().includes(lowered)) found.push(`${file}:${i + 1}`);
    });
  }
  return found;
}

/**
 * Второй механизм: граница слова, но не через `\b`. `\b` в JS определяется
 * через `\w` ([A-Za-z0-9_]) — подчёркивание туда входит, а подчёркивание
 * это ровно то, чем идентификаторы, имена файлов и куски путей приклеивают
 * инициалы клиента к остальному тексту: имя-репозитория-через-подчёркивание,
 * конфиг-переменная с префиксом. `\bTOKEN\b` такое не ловит — на стыке с
 * `_` границы нет ни слева, ни справа.
 *
 * Поэтому граница здесь — явная: соседний символ не должен быть буквой или
 * цифрой, подчёркивание в это множество не входит и само считается границей.
 * `(?<![A-Za-z0-9])TOKEN(?![A-Za-z0-9])` вместо `\bTOKEN\b`.
 *
 * Свойство, ради которого границы вводились, сохраняется: внутри base64
 * оба соседних символа — буквы/цифры, значит границы нет и генерируемые
 * файлы (package-lock.json и подобные) молчат. Свойство, которого не
 * хватало, добавляется: подчёркивание — уже граница, кириллица, пунктуация
 * и пробелы — тоже (они и раньше были не-\w, ничего не изменилось).
 *
 * Класс, который эта граница НЕ закрывает: буква вплотную к букве без
 * разделителя (PascalCase/camelCase-склейка токена с соседним словом —
 * сосед-буква неотличим от продолжения того же слова, это и есть условие,
 * ради которого база64 молчит) и токен, чьи буквы сами разбиты не подряд
 * (например, через точку между каждой буквой) — тогда искомая подстрока
 * не встречается целиком вовсе, регэксп её просто не находит. Это не баг,
 * а тот же компромисс, что и с base64: убрать любую границу-по-букве —
 * значит снова шуметь на генерируемых файлах.
 */
function tokenPattern(token: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${token}(?![A-Za-z0-9])`, 'i');
}

function tokenHits(token: string): string[] {
  const found: string[] = [];
  const re = tokenPattern(token);
  for (const file of trackedTextFiles()) {
    const body = readFileSync(path.join(ROOT, file), 'utf8');
    body.split('\n').forEach((line, i) => {
      if (re.test(line)) found.push(`${file}:${i + 1}`);
    });
  }
  return found;
}

describe('публичное дерево не выносит личное', () => {
  it('имя клиента не встречается ни разу', () => {
    expect(hits(CLIENT)).toEqual([]);
  });

  it('имя клиента кириллицей не встречается ни разу', () => {
    expect(hits(CLIENT_CYR)).toEqual([]);
  });

  it('путей из домашнего каталога нет', () => {
    expect(hits(HOMEDIR)).toEqual([]);
  });

  it('личной почты нет', () => {
    expect(hits(MAIL)).toEqual([]);
  });

  it.each(TOKENS)('токен-инициал %s не встречается ни разу (по границе, а не по \\b)', (token) => {
    expect(tokenHits(token)).toEqual([]);
  });

  describe('сам механизм границы (синтетика, не дерево)', () => {
    // Эти проверки — про правило, а не про текущее состояние репозитория:
    // они гоняют tokenPattern() на выдуманных строках, собранных из тех же
    // констант, что и сами токены, а не на файлах дерева.
    it.each(TOKENS)('токен %s находится, если приклеен подчёркиванием с любой стороны', (token) => {
      const re = tokenPattern(token);
      expect(re.test(`x_${token}_astro`)).toBe(true);
      expect(re.test(`data_${token}`)).toBe(true);
      expect(re.test(`${token}_config`)).toBe(true);
    });

    it.each(TOKENS)('токен %s НЕ находится внутри непрерывного алфавитно-цифрового текста (base64-случай)', (token) => {
      const re = tokenPattern(token);
      expect(re.test(`ab${token}cd`)).toBe(false);
      expect(re.test(`9${token}9`)).toBe(false);
      expect(re.test(`ab${token}9`)).toBe(false);
    });

    it.each(TOKENS)('токен %s находится один, через пунктуацию, пробелы и кириллицу', (token) => {
      const re = tokenPattern(token);
      expect(re.test(token)).toBe(true);
      expect(re.test(`(${token})`)).toBe(true);
      expect(re.test(`слово ${token} слово`)).toBe(true);
      expect(re.test(`слово-${token}-слово`)).toBe(true);
      expect(re.test(`слово${token}слово`)).toBe(true);
    });
  });

  it('сам замок не хранит искомые слова строкой', () => {
    // Если кто-то «упростит» сборку из букв до литерала, тест поймает себя.
    // Проверяются ВСЕ константы-иголки, а не только клиентское имя: HOMEDIR
    // палит домашний каталог того, кто это писал, а MAIL — его личную почту.
    const self = readFileSync(path.join(ROOT, 'scripts/__tests__/public-tree.test.ts'), 'utf8');
    expect(self.toLowerCase()).not.toContain(CLIENT.toLowerCase());
    expect(self.toLowerCase()).not.toContain(CLIENT_CYR.toLowerCase());
    expect(self.toLowerCase()).not.toContain(HOMEDIR.toLowerCase());
    expect(self.toLowerCase()).not.toContain(MAIL.toLowerCase());
    for (const token of TOKENS) {
      expect(self.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });
});
