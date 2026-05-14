import { describe, it, expect } from 'vitest';
import { parseTime, timeAfter } from './time.js';

describe('parseTime', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    expect(parseTime('07:00')).toBe('07:00:00');
    expect(parseTime('07:00:00')).toBe('07:00:00');
    expect(parseTime('7:5')).toBe('07:05:00');
    expect(parseTime('17:30:45')).toBe('17:30:45');
  });

  it('rejects out-of-range', () => {
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
    expect(parseTime('not')).toBeNull();
    expect(parseTime('')).toBeNull();
  });
});

describe('timeAfter', () => {
  it('compares HH:MM:SS strings lexicographically', () => {
    expect(timeAfter('07:00:00', '17:00:00')).toBe(true);
    expect(timeAfter('17:00:00', '07:00:00')).toBe(false);
    expect(timeAfter('10:00:00', '10:00:00')).toBe(false);
  });
});
