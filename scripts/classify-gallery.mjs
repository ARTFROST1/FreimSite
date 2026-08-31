#!/usr/bin/env node
/**
 * Статус разметки набора `archive` (docs/recipes/photo-archive.md, шаг 3):
 * сколько кадров из `.staging/collages/index.json` уже попало в
 * `.staging/classification.json` и какие значения там встречаются. Читает
 * то же, что пишет `merge-classification.mjs --set=archive` — удобно
 * прогнать между волнами разметки, не открывая сам JSON.
 *
 * Запуск:
 *   node scripts/classify-gallery.mjs --stats
 *   node scripts/classify-gallery.mjs --detail   # + разбивка по category/shot
 */
import fs from 'node:fs';
import path from 'node:path';
import { STAGING } from './media.config.mjs';

const classificationPath = path.join(STAGING, 'classification.json');
const indexPath = path.join(STAGING, 'collages/index.json');

function loadClassification() {
  if (fs.existsSync(classificationPath)) {
    return JSON.parse(fs.readFileSync(classificationPath, 'utf-8'));
  }
  return { version: 1, items: {} };
}

function loadIndex() {
  return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
}

function getStats() {
  const classification = loadClassification();
  const index = loadIndex();

  let totalItems = 0;
  let classifiedItems = 0;

  index.forEach((collage) => {
    collage.cells.forEach((cell) => {
      totalItems++;
      if (classification.items[cell.id]) classifiedItems++;
    });
  });

  const stats = {
    total: totalItems,
    classified: classifiedItems,
    remaining: totalItems - classifiedItems,
    percent: totalItems ? Math.round((classifiedItems / totalItems) * 100) : 0,
  };

  console.log(`Статус: ${stats.classified}/${stats.total} (${stats.percent}%) размечено`);
  console.log(`Осталось: ${stats.remaining}`);

  if (process.argv[2] === '--detail') {
    const categories = {};
    const shots = {};
    let watermarked = 0;
    let unusable = 0;

    Object.values(classification.items).forEach((item) => {
      if (item.category) categories[item.category] = (categories[item.category] || 0) + 1;
      if (item.shot) shots[item.shot] = (shots[item.shot] || 0) + 1;
      if (item.watermark) watermarked++;
      if (!item.usable) unusable++;
    });

    console.log('\nПо категориям:');
    Object.entries(categories).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

    console.log('\nПо типу съёмки:');
    Object.entries(shots).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

    console.log(`\nС водяным знаком: ${watermarked}`);
    console.log(`Отбраковано: ${unusable}`);
  }
}

const cmd = process.argv[2];

if (cmd === '--stats' || cmd === '--detail') {
  if (!fs.existsSync(indexPath)) {
    console.error(`Нет ${path.relative(STAGING, indexPath)} — сначала node scripts/build-collages.mjs`);
    process.exit(1);
  }
  getStats();
} else {
  console.log('Использование: node scripts/classify-gallery.mjs [--stats|--detail]');
}
