import { describe, it, expect } from 'vitest';
import { sanitizeRange, isLayout, applyLayout } from './layout.js';

describe('sanitizeRange', () => {
  it('accepts standard A1 ranges', () => {
    expect(sanitizeRange('A1:Z100')).toBe('A1:Z100');
    expect(sanitizeRange('A:A')).toBe('A:A');
    expect(sanitizeRange('1:5')).toBe('1:5');
    expect(sanitizeRange('A1')).toBe('A1');
    expect(sanitizeRange('AA1:ZZ9999')).toBe('AA1:ZZ9999');
  });

  it('returns undefined for missing input', () => {
    expect(sanitizeRange(undefined)).toBeUndefined();
    expect(sanitizeRange('')).toBeUndefined();
  });

  it('throws on invalid formats', () => {
    expect(() => sanitizeRange('1.5')).toThrow(/A1 notation/);
    expect(() => sanitizeRange('foo')).toThrow(/A1 notation/);
    expect(() => sanitizeRange('A1:Z100; DROP TABLE users')).toThrow(/A1 notation/);
    expect(() => sanitizeRange("' OR 1=1")).toThrow(/A1 notation/);
    expect(() => sanitizeRange('!A1')).toThrow(/A1 notation/);
  });
});

describe('isLayout', () => {
  it('accepts the three known layouts', () => {
    expect(isLayout('table')).toBe(true);
    expect(isLayout('raw')).toBe(true);
    expect(isLayout('matrix')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isLayout(undefined)).toBe(false);
    expect(isLayout('')).toBe(false);
    expect(isLayout('TABLE')).toBe(false);
    expect(isLayout('csv')).toBe(false);
  });
});

describe('applyLayout', () => {
  const values = [['name', 'age'], ['Alice', '30'], ['Bob', '25']];

  it('table → array of row objects', () => {
    expect(applyLayout(values, 'table')).toEqual([
      { name: 'Alice', age: '30' },
      { name: 'Bob', age: '25' },
    ]);
  });

  it('raw → original 2D values', () => {
    expect(applyLayout(values, 'raw')).toBe(values);
  });

  it('matrix → first column becomes row key', () => {
    expect(applyLayout(values, 'matrix')).toEqual({
      Alice: { age: '30' },
      Bob: { age: '25' },
    });
  });
});
