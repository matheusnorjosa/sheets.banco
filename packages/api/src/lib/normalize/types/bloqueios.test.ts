import { describe, it, expect } from 'vitest';
import { normalizeBloqueioRow } from './bloqueios.js';

describe('normalizeBloqueioRow', () => {
  it('normalizes date-only Total block', () => {
    const { normalized, validation } = normalizeBloqueioRow({
      'Usuário': 'Pessoa Exemplo',
      Inicio: '28/02/2026',
      Fim: '02/03/2026',
      Tipo: 'Total',
    });
    expect(normalized).toMatchObject({
      usuario_original: 'Pessoa Exemplo',
      usuario_key: 'PESSOA EXEMPLO',
      inicio_iso: '2026-02-28T00:00:00-03:00',
      fim_iso: '2026-03-02T23:59:59-03:00',
      tipo_original: 'Total',
      tipo_key: 'T',
    });
    expect(validation.status).toBe('valid');
  });

  it('accepts Parcial → P', () => {
    const { normalized } = normalizeBloqueioRow({
      'Usuário': 'X', Inicio: '01/01/2026', Fim: '01/01/2026', Tipo: 'Parcial',
    });
    expect(normalized.tipo_key).toBe('P');
  });

  it('warns on unsupported D type', () => {
    const { validation } = normalizeBloqueioRow({
      'Usuário': 'X', Inicio: '01/01/2026', Fim: '01/01/2026', Tipo: 'D',
    });
    expect(validation.warnings.some((w) => w.code === 'UNSUPPORTED_BLOCK_TYPE_D')).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('errors when usuario / dates missing', () => {
    const { validation } = normalizeBloqueioRow({ 'Usuário': '', Inicio: '', Fim: '', Tipo: '' });
    expect(validation.errors.some((e) => e.code === 'USER_REQUIRED')).toBe(true);
    expect(validation.errors.some((e) => e.code === 'START_REQUIRED')).toBe(true);
    expect(validation.errors.some((e) => e.code === 'END_REQUIRED')).toBe(true);
    expect(validation.errors.some((e) => e.code === 'TYPE_REQUIRED')).toBe(true);
  });

  it('errors when fim <= inicio', () => {
    const { validation } = normalizeBloqueioRow({
      'Usuário': 'X', Inicio: '02/03/2026', Fim: '01/03/2026', Tipo: 'Total',
    });
    expect(validation.errors.some((e) => e.code === 'TIME_ORDER')).toBe(true);
  });

  it('single-day block stays valid (start of day < end of day)', () => {
    const { normalized, validation } = normalizeBloqueioRow({
      'Usuário': 'X', Inicio: '01/01/2026', Fim: '01/01/2026', Tipo: 'T',
    });
    expect(validation.status).toBe('valid');
    expect(normalized.inicio_iso).toBe('2026-01-01T00:00:00-03:00');
    expect(normalized.fim_iso).toBe('2026-01-01T23:59:59-03:00');
  });
});
