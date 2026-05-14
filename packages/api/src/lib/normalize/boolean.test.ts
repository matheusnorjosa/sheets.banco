import { describe, it, expect } from 'vitest';
import { parseBoolean } from './boolean.js';

describe('parseBoolean', () => {
  it('parses true variants', () => {
    expect(parseBoolean('SIM')).toBe(true);
    expect(parseBoolean('Sim')).toBe(true);
    expect(parseBoolean('TRUE')).toBe(true);
    expect(parseBoolean('1')).toBe(true);
    expect(parseBoolean('x')).toBe(true);
  });

  it('parses false variants', () => {
    expect(parseBoolean('NÃO')).toBe(false);
    expect(parseBoolean('nao')).toBe(false);
    expect(parseBoolean('FALSE')).toBe(false);
    expect(parseBoolean('0')).toBe(false);
  });

  it('returns null for unknown/empty', () => {
    expect(parseBoolean(null)).toBeNull();
    expect(parseBoolean('')).toBeNull();
    expect(parseBoolean('maybe')).toBeNull();
  });
});
