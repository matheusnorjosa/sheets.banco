import { describe, it, expect } from 'vitest';
import { parseMonth, daysInMonth } from './month.js';

describe('parseMonth', () => {
  it('parses full names', () => {
    expect(parseMonth('Janeiro')).toBe(1);
    expect(parseMonth('Dezembro')).toBe(12);
  });

  it('parses abbreviated names with/without dot', () => {
    expect(parseMonth('JAN.')).toBe(1);
    expect(parseMonth('jan')).toBe(1);
    expect(parseMonth('FEV')).toBe(2);
    expect(parseMonth('DEZ.')).toBe(12);
  });

  it('handles accents', () => {
    expect(parseMonth('Março')).toBe(3);
  });

  it('returns null for unknown', () => {
    expect(parseMonth('foo')).toBeNull();
    expect(parseMonth('')).toBeNull();
    expect(parseMonth(null)).toBeNull();
  });
});

describe('daysInMonth', () => {
  it('handles leap years', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
  });

  it('returns correct lengths', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
  });
});
