import { describe, it, expect } from 'vitest';
import { parseDateBR, isoCombine } from './date.js';

describe('parseDateBR', () => {
  it('parses dd/mm/yyyy', () => {
    expect(parseDateBR('13/11/2023')).toBe('2023-11-13');
    expect(parseDateBR('03/06/2025')).toBe('2025-06-03');
    expect(parseDateBR('1/3/2024')).toBe('2024-03-01');
  });

  it('parses dd-mm-yyyy and dd.mm.yyyy', () => {
    expect(parseDateBR('13-11-2023')).toBe('2023-11-13');
    expect(parseDateBR('13.11.2023')).toBe('2023-11-13');
  });

  it('passes through ISO dates', () => {
    expect(parseDateBR('2023-11-13')).toBe('2023-11-13');
  });

  it('returns null on invalid input', () => {
    expect(parseDateBR(null)).toBeNull();
    expect(parseDateBR('')).toBeNull();
    expect(parseDateBR('not-a-date')).toBeNull();
    expect(parseDateBR('30/02/2024')).toBeNull(); // Feb 30
    expect(parseDateBR('00/01/2024')).toBeNull();
  });

  it('expands 2-digit year', () => {
    expect(parseDateBR('13/11/23')).toBe('2023-11-13');
    expect(parseDateBR('13/11/99')).toBe('1999-11-13');
  });
});

describe('isoCombine', () => {
  it('produces ISO with default -03 tz', () => {
    expect(isoCombine('2026-02-12', '07:00:00')).toBe('2026-02-12T07:00:00-03:00');
  });
});
