import { uppercaseKey } from './text.js';

/**
 * Map a Portuguese month name (full, short, with/without dot) to its 1-12 index.
 * Returns null if unknown.
 */
const MONTH_MAP: Record<string, number> = {
  JAN: 1, JANEIRO: 1,
  FEV: 2, FEVEREIRO: 2,
  MAR: 3, MARCO: 3,
  ABR: 4, ABRIL: 4,
  MAI: 5, MAIO: 5,
  JUN: 6, JUNHO: 6,
  JUL: 7, JULHO: 7,
  AGO: 8, AGOSTO: 8,
  SET: 9, SETEMBRO: 9,
  OUT: 10, OUTUBRO: 10,
  NOV: 11, NOVEMBRO: 11,
  DEZ: 12, DEZEMBRO: 12,
};

export function parseMonth(input: unknown): number | null {
  const key = uppercaseKey(input).replace(/\.$/, '');
  return MONTH_MAP[key] ?? null;
}

/**
 * Days in a given month/year (handles leap years for Feb).
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
