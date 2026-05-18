import { describe, it, expect } from 'vitest';
import {
  sanitizeRange,
  isLayout,
  applyLayout,
  parseRenderOptions,
  parseHeaderRow,
} from './layout.js';

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

describe('parseRenderOptions', () => {
  it('returns {} when neither param is set', () => {
    expect(parseRenderOptions(undefined, undefined)).toEqual({});
    expect(parseRenderOptions('', '')).toEqual({});
  });

  it.each([
    ['formatted',   'FORMATTED_VALUE'],
    ['unformatted', 'UNFORMATTED_VALUE'],
    ['formula',     'FORMULA'],
  ])('maps render=%s → valueRenderOption=%s', (input, expected) => {
    expect(parseRenderOptions(input, undefined)).toEqual({ valueRenderOption: expected });
  });

  it.each([
    ['serial', 'SERIAL_NUMBER'],
    ['string', 'FORMATTED_STRING'],
  ])('maps dateTime=%s → dateTimeRenderOption=%s', (input, expected) => {
    expect(parseRenderOptions(undefined, input)).toEqual({ dateTimeRenderOption: expected });
  });

  it('combines both when present', () => {
    expect(parseRenderOptions('unformatted', 'serial')).toEqual({
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
  });

  it('throws on unknown render', () => {
    expect(() => parseRenderOptions('json', undefined)).toThrow(/Invalid render option/);
    expect(() => parseRenderOptions('FORMATTED_VALUE', undefined)).toThrow(/Invalid render option/);
  });

  it('throws on unknown dateTime', () => {
    expect(() => parseRenderOptions(undefined, 'iso')).toThrow(/Invalid dateTime option/);
  });
});

describe('parseHeaderRow', () => {
  it('returns undefined when the param is absent or empty', () => {
    expect(parseHeaderRow(undefined)).toBeUndefined();
    expect(parseHeaderRow('')).toBeUndefined();
  });

  it('returns the parsed positive integer', () => {
    expect(parseHeaderRow('1')).toBe(1);
    expect(parseHeaderRow('5')).toBe(5);
    expect(parseHeaderRow('100')).toBe(100);
  });

  it('throws on zero or negative', () => {
    expect(() => parseHeaderRow('0')).toThrow(/positive integer/);
    expect(() => parseHeaderRow('-1')).toThrow(/positive integer/);
  });

  it('throws on non-integer', () => {
    expect(() => parseHeaderRow('1.5')).toThrow(/positive integer/);
    expect(() => parseHeaderRow('foo')).toThrow(/positive integer/);
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
