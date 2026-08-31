import { describe, expect, it } from 'vitest';
import { parsePrice } from '../price';

/**
 * parsePrice питает `offers` в Product JSON-LD и оба товарных фида (yml.xml,
 * google-merchant.xml): выдуманная цена = санкции поисковиков, поэтому
 * фиксируем и «читаемые» форматы, которые пишет заказчик, и мусор, который
 * обязан давать undefined.
 */
describe('parsePrice', () => {
  it('разбирает типовые форматы из CMS', () => {
    expect(parsePrice('12500')).toBe(12500);
    expect(parsePrice('от 12 500 ₽')).toBe(12500);
    expect(parsePrice('12 500 руб.')).toBe(12500);
    expect(parsePrice('120 500 ₽')).toBe(120500);
    expect(parsePrice('12.500 ₽')).toBe(12500);
  });

  it('понимает неразрывный пробел — им разделяет разряды любой текстовый редактор', () => {
    expect(parsePrice('\u00A0от 12\u00A0500\u00A0₽')).toBe(12500);
  });

  it('различает копейки и разряды — «99,90» это не 9990', () => {
    // Разрядная группа всегда из трёх цифр, дробная — из одной-двух.
    expect(parsePrice('99,90 ₽')).toBe(99.9);
    expect(parsePrice('99.90 ₽')).toBe(99.9);
    expect(parsePrice('1 299,50 ₽')).toBe(1299.5);
    expect(parsePrice('1.299,50 ₽')).toBe(1299.5);
    expect(parsePrice('от 12 500,00 ₽')).toBe(12500);
    // …а разрядные разделители продолжают работать как раньше.
    expect(parsePrice('12.500 ₽')).toBe(12500);
    expect(parsePrice('12,500 ₽')).toBe(12500);
    expect(parsePrice('1 200 000 ₽')).toBe(1200000);
  });

  it('не выдумывает цену из мусора', () => {
    expect(parsePrice(undefined)).toBeUndefined();
    expect(parsePrice('')).toBeUndefined();
    expect(parsePrice('по запросу')).toBeUndefined();
    expect(parsePrice('0 ₽')).toBeUndefined();
  });
});
