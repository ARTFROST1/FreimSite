import { describe, expect, it } from 'vitest';
import {
  MAX_FILES,
  MAX_FILE_SIZE,
  MAX_FILE_SIZE_LABEL,
  addAttachments,
  attachmentExt,
} from '../lead-attachments';

/**
 * DOM-часть (скрепка, оверлей drag&drop, синхронизация через DataTransfer,
 * отзыв blob-URL) живёт в LeadAttachments.astro и проверяется руками в
 * браузере — `DataTransfer` и `URL.createObjectURL` в node-окружении не
 * воспроизводятся честно. Здесь — вся арифметика лимитов, ради которой она и
 * вынесена в чистую функцию.
 */

const file = (name: string, size: number) => ({ name, size });

describe('addAttachments', () => {
  it('принимает файлы в пределах лимитов и не мутирует прошлый набор', () => {
    const current = [file('smeta.pdf', 1000)];
    const result = addAttachments(current, [file('foto.heic', 2000)]);

    expect(result.files.map((f) => f.name)).toEqual(['smeta.pdf', 'foto.heic']);
    expect(result.rejected).toEqual([]);
    expect(current).toHaveLength(1); // исходный массив остался как был
  });

  it('НЕ фильтрует по типу: экзотические расширения проходят', () => {
    const result = addAttachments(
      [],
      [file('photo.heic', 10), file('smeta.docx', 10), file('project.zip', 10), file('no-ext', 10)],
    );

    expect(result.files).toHaveLength(4);
    expect(result.rejected).toEqual([]);
  });

  it('режет файл тяжелее лимита и называет причину', () => {
    const result = addAttachments([], [file('video.mov', MAX_FILE_SIZE + 1)]);

    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual([`Файл «video.mov» не добавлен: больше ${MAX_FILE_SIZE_LABEL}`]);
  });

  it('файл ровно на лимите проходит (граница включительная)', () => {
    const result = addAttachments([], [file('edge.jpg', MAX_FILE_SIZE)]);

    expect(result.files).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it('отклоняет пустой файл — сервер его всё равно выбросит', () => {
    const result = addAttachments([], [file('empty.txt', 0)]);

    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual(['Файл «empty.txt» не добавлен: пустой файл']);
  });

  it('упирается в MAX_FILES и объясняет отказ по каждому лишнему', () => {
    const current = Array.from({ length: MAX_FILES }, (_, i) => file(`f${i}.jpg`, 10));
    const result = addAttachments(current, [file('sixth.jpg', 10), file('seventh.jpg', 10)]);

    expect(result.files).toHaveLength(MAX_FILES);
    expect(result.rejected).toEqual([
      `Файл «sixth.jpg» не добавлен: максимум ${MAX_FILES} файлов`,
      `Файл «seventh.jpg» не добавлен: максимум ${MAX_FILES} файлов`,
    ]);
  });

  it('принимает пачку до лимита и отсекает хвост', () => {
    const incoming = Array.from({ length: MAX_FILES + 2 }, (_, i) => file(`f${i}.jpg`, 10));
    const result = addAttachments([], incoming);

    expect(result.files).toHaveLength(MAX_FILES);
    expect(result.rejected).toHaveLength(2);
  });

  it('дубль при ПОЛНОМ наборе не даёт ложного «максимум 5 файлов»', () => {
    // Повторный drop уже приложенного файла ничего не занимает — отказывать
    // не за что (дедуп идёт раньше проверки лимита).
    const current = Array.from({ length: MAX_FILES }, (_, i) => file(`f${i}.jpg`, 10));
    const result = addAttachments(current, [file('f0.jpg', 10)]);

    expect(result.files).toHaveLength(MAX_FILES);
    expect(result.rejected).toEqual([]);
  });

  it('при полном наборе дубль молчит, а новый файл получает причину', () => {
    const current = Array.from({ length: MAX_FILES }, (_, i) => file(`f${i}.jpg`, 10));
    const result = addAttachments(current, [file('f1.jpg', 10), file('new.jpg', 10)]);

    expect(result.files).toHaveLength(MAX_FILES);
    expect(result.rejected).toEqual([
      `Файл «new.jpg» не добавлен: максимум ${MAX_FILES} файлов`,
    ]);
  });

  it('дубль внутри одной пачки не съедает слот лимита', () => {
    const result = addAttachments([], Array.from({ length: 8 }, () => file('same.jpg', 10)));

    expect(result.files).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it('дубль (имя + размер) пропускается молча, без причины отказа', () => {
    const result = addAttachments([file('plan.pdf', 500)], [file('plan.pdf', 500)]);

    expect(result.files).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it('одноимённый файл другого размера — это другой файл', () => {
    const result = addAttachments([file('plan.pdf', 500)], [file('plan.pdf', 900)]);

    expect(result.files).toHaveLength(2);
  });

  it('причины копятся только за текущий вызов', () => {
    const first = addAttachments([], [file('big.mov', MAX_FILE_SIZE + 1)]);
    expect(first.rejected).toHaveLength(1);

    const second = addAttachments(first.files, [file('ok.jpg', 10)]);
    expect(second.rejected).toEqual([]);
  });

  it('отказ по размеру не мешает принять остальные файлы пачки', () => {
    const result = addAttachments(
      [],
      [file('ok1.jpg', 10), file('big.mov', MAX_FILE_SIZE + 1), file('ok2.jpg', 10)],
    );

    expect(result.files.map((f) => f.name)).toEqual(['ok1.jpg', 'ok2.jpg']);
    expect(result.rejected).toHaveLength(1);
  });
});

describe('MAX_FILE_SIZE_LABEL', () => {
  it('собирается из MAX_FILE_SIZE — цифра в подсказках не разъедется с лимитом', () => {
    expect(MAX_FILE_SIZE_LABEL).toBe(`${MAX_FILE_SIZE / (1024 * 1024)} МБ`);
  });

  it('целый лимит печатается без десятичного хвоста', () => {
    expect(MAX_FILE_SIZE_LABEL).toBe('5 МБ');
  });

  it('НЕ округляет вверх: подпись не обещает больше, чем пропустит лимит', () => {
    // Дублируем формулу из модуля на нецелом лимите: Math.round(4.8) дал бы
    // «5 МБ» — обещание, на котором посетитель получит отказ.
    const label = (bytes: number) => `${Math.floor((bytes / (1024 * 1024)) * 10) / 10} МБ`;

    expect(label(4.8 * 1024 * 1024)).toBe('4.8 МБ');
    expect(label(4.99 * 1024 * 1024)).toBe('4.9 МБ');
    expect(label(20 * 1024 * 1024)).toBe('20 МБ');
  });
});

describe('attachmentExt', () => {
  it('отдаёт расширение в нижнем регистре', () => {
    expect(attachmentExt('Smeta.PDF')).toBe('pdf');
    expect(attachmentExt('photo.HEIC')).toBe('heic');
  });

  it('без расширения — нейтральное слово, а не пустая подпись', () => {
    expect(attachmentExt('scan')).toBe('файл');
    expect(attachmentExt('')).toBe('файл');
    expect(attachmentExt('archive.')).toBe('файл');
  });

  it('точки внутри имени не путают — берётся последний сегмент', () => {
    expect(attachmentExt('my.plan.v2.dwg')).toBe('dwg');
  });
});
