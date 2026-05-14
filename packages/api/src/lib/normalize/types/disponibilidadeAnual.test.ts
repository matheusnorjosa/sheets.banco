import { describe, it, expect } from 'vitest';
import { normalizeDisponibilidadeAnualRow } from './disponibilidadeAnual.js';

describe('normalizeDisponibilidadeAnualRow', () => {
  it('normalizes month columns to 1..12', () => {
    const { normalized, validation } = normalizeDisponibilidadeAnualRow({
      FORMADOR: 'Pessoa Exemplo',
      'JAN.': '0',
      'FEV.': '16',
      'MAR.': '54',
      'ABR.': '56',
      'MAI.': '83',
      'JUN.': '82',
      'JUL.': '48',
      'AGO.': '56',
      'SET.': '64',
      'OUT.': '80',
      'NOV.': '40',
      'DEZ.': '8',
    }, { ano: 2026 });

    expect(normalized.usuario_original).toBe('Pessoa Exemplo');
    expect(normalized.periodo).toEqual({ tipo: 'anual', ano: 2026 });
    expect(normalized.meses).toHaveLength(12);
    expect(normalized.meses[0]).toEqual({ mes: 1, valor_original: '0', valor_normalizado: 0 });
    expect(normalized.meses[1]).toEqual({ mes: 2, valor_original: '16', valor_normalizado: 16 });
    expect(normalized.meses[11]).toEqual({ mes: 12, valor_original: '8', valor_normalizado: 8 });
    expect(validation.status).toBe('valid');
  });

  it('parses Brazilian formatted numbers (1.234,56)', () => {
    const { normalized } = normalizeDisponibilidadeAnualRow({
      FORMADOR: 'X',
      'MAI.': '1.234,5',
    }, { ano: 2026 });
    expect(normalized.meses[0].valor_normalizado).toBe(1234.5);
  });

  it('warns when ano unknown', () => {
    const { validation } = normalizeDisponibilidadeAnualRow({ FORMADOR: 'X', 'JAN.': '10' });
    expect(validation.warnings.some((w) => w.code === 'PERIOD_UNKNOWN')).toBe(true);
  });

  it('warns on non-numeric month values', () => {
    const { validation } = normalizeDisponibilidadeAnualRow({
      FORMADOR: 'X', 'JAN.': 'foo',
    }, { ano: 2026 });
    expect(validation.warnings.some((w) => w.code === 'MONTH_VALUE_NON_NUMERIC')).toBe(true);
  });

  it('captures Ranking column when present', () => {
    const { normalized } = normalizeDisponibilidadeAnualRow({
      FORMADOR: 'X', 'JAN.': '0', Ranking: '3',
    }, { ano: 2026 });
    expect(normalized.ranking).toBe(3);
  });

  it('errors when user empty', () => {
    const { validation } = normalizeDisponibilidadeAnualRow({ FORMADOR: '', 'JAN.': '0' }, { ano: 2026 });
    expect(validation.errors.some((e) => e.code === 'USER_REQUIRED')).toBe(true);
  });
});
