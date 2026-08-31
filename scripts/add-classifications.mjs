#!/usr/bin/env node
/**
 * Точечная правка `.staging/classification.json` в обход валидатора
 * `merge-classification.mjs`: дописывает объект `{ id: {category, shot, …} }`
 * из локального модуля прямо в файл.
 *
 * КОГДА ЭТИМ МОЖНО ПОЛЬЗОВАТЬСЯ. У этого пути нет защиты «файл на коллаж»
 * из `merge-classification.mjs` — именно она была введена после инцидента,
 * когда разметка части архива оказалась выдуманной (см. доккомент того
 * скрипта). Используйте `add-classifications.mjs` только для точечных правок
 * уже проверенных значений (правка одной ошибочной категории, перенос
 * разметки между проектами) — не для первичной разметки архива россыпью:
 * для неё есть `build-collages.mjs` / `build-media-collages.mjs` +
 * `merge-classification.mjs` с механической проверкой покрытия.
 *
 * Запуск:
 *   node scripts/add-classifications.mjs path/to/patch.mjs
 *
 * Файл-аргумент — ES-модуль с `export default { "<id>": {category, shot, …} }`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STAGING } from './media.config.mjs';

const classificationPath = path.join(STAGING, 'classification.json');

function loadClassification() {
  if (fs.existsSync(classificationPath)) {
    return JSON.parse(fs.readFileSync(classificationPath, 'utf-8'));
  }
  return { version: 1, items: {} };
}

function saveClassification(data) {
  fs.writeFileSync(classificationPath, JSON.stringify(data, null, 2));
  console.log(`Записано: ${classificationPath}`);
}

function addClassifications(newItems) {
  const current = loadClassification();
  Object.assign(current.items, newItems);
  saveClassification(current);

  const count = Object.keys(newItems).length;
  const total = Object.keys(current.items).length;
  console.log(`Добавлено ${count} кадров (всего в файле: ${total})`);
}

if (process.argv[2]) {
  const file = process.argv[2];
  if (!fs.existsSync(file)) {
    console.error(`Файл не найден: ${file}`);
    process.exit(1);
  }

  const module = await import(`file://${path.resolve(file)}`);
  const classifications = module.default || module;

  addClassifications(classifications);
} else {
  console.log('Использование: node scripts/add-classifications.mjs <path-to-js-file>');
}
