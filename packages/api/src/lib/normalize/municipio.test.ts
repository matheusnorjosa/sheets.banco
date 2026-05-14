import { describe, it, expect } from 'vitest';
import { parseMunicipio, isUfValid } from './municipio.js';

describe('parseMunicipio', () => {
  it('parses "NOME - UF" with embedded UF', () => {
    expect(parseMunicipio('ITAGI - BA')).toEqual({
      name: 'ITAGI',
      uf: 'BA',
      key: 'ITAGI_BA',
    });
  });

  it('parses "NOME/UF" variant', () => {
    expect(parseMunicipio('Belo Horizonte / MG')).toEqual({
      name: 'Belo Horizonte',
      uf: 'MG',
      key: 'BELO_HORIZONTE_MG',
    });
  });

  it('uses fallback UF when input has no UF suffix', () => {
    expect(parseMunicipio('FELIXLANDIA', 'MG')).toEqual({
      name: 'FELIXLANDIA',
      uf: 'MG',
      key: 'FELIXLANDIA_MG',
    });
  });

  it('removes accents in key', () => {
    expect(parseMunicipio('FELIXLÂNDIA', 'MG').key).toBe('FELIXLANDIA_MG');
  });

  it('returns name without UF when no fallback is given', () => {
    expect(parseMunicipio('LUGAR DESCONHECIDO')).toEqual({
      name: 'LUGAR DESCONHECIDO',
      uf: null,
      key: null,
    });
  });

  it('handles nullish', () => {
    expect(parseMunicipio(null)).toEqual({ name: null, uf: null, key: null });
  });
});

describe('isUfValid', () => {
  it('accepts known UFs', () => {
    expect(isUfValid('BA')).toBe(true);
    expect(isUfValid('mg')).toBe(true);
  });
  it('rejects unknown', () => {
    expect(isUfValid('XX')).toBe(false);
    expect(isUfValid('')).toBe(false);
  });
});
