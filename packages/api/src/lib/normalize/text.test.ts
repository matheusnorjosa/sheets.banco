import { describe, it, expect } from 'vitest';
import { trimAll, collapseSpaces, removeAccents, uppercaseKey } from './text.js';

describe('text helpers', () => {
  it('trimAll handles nullish', () => {
    expect(trimAll(null)).toBe('');
    expect(trimAll(undefined)).toBe('');
    expect(trimAll('  hi  ')).toBe('hi');
    expect(trimAll(42)).toBe('42');
  });

  it('collapseSpaces flattens whitespace runs', () => {
    expect(collapseSpaces('a  b   c')).toBe('a b c');
    expect(collapseSpaces('a\tb\nc')).toBe('a b c');
  });

  it('removeAccents strips diacritics', () => {
    expect(removeAccents('ÁÉÍÓÚÇÃÕ')).toBe('AEIOUCAO');
    expect(removeAccents('Felixlândia')).toBe('Felixlandia');
  });

  it('uppercaseKey combines steps and is empty-safe', () => {
    expect(uppercaseKey('  felixlândia  ')).toBe('FELIXLANDIA');
    expect(uppercaseKey('Coord Acompanha')).toBe('COORD ACOMPANHA');
    expect(uppercaseKey('')).toBe('');
    expect(uppercaseKey(null)).toBe('');
  });
});
