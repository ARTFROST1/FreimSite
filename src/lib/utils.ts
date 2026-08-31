import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes safely (dedupes conflicting utilities). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format a number as RUB currency (no fraction digits). */
export function formatPrice(value: number, currency = 'RUB'): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

/** Format an ISO date for display: "5 июля 2026". */
export function formatDate(date: Date | string, locale = 'ru-RU'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Strip everything but digits and a leading + (for tel:/wa.me hrefs). */
export function phoneHref(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

/** Rough reading-time estimate from raw text (200 wpm). */
export function readingTime(text: string, wpm = 200): string {
  const words = text.trim().split(/\s+/).length;
  return `${Math.max(1, Math.round(words / wpm))} мин`;
}
