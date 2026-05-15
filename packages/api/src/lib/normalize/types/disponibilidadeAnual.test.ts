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

describe('normalizeDisponibilidadeAnualRow — Rk1..Rk13 columns', () => {
  function rowWithRks(rks: Partial<Record<string, string>>) {
    return {
      FORMADOR: 'X', 'JAN.': '0',
      ...rks,
    };
  }

  it('Rk1..Rk12 map to rankings_mensais by month index', () => {
    const { normalized } = normalizeDisponibilidadeAnualRow(rowWithRks({
      Rk1: '5', Rk2: '8', Rk3: '15', Rk4: '20', Rk5: '23', Rk6: '6',
      Rk7: '2', Rk8: '10', Rk9: '3', Rk10: '13', Rk11: '5', Rk12: '5',
    }), { ano: 2026 });

    expect(normalized.rankings_mensais).toHaveLength(12);
    expect(normalized.rankings_mensais[0]).toEqual({ mes: 1, valor_original: '5', ranking: 5 });
    expect(normalized.rankings_mensais[1]).toEqual({ mes: 2, valor_original: '8', ranking: 8 });
    expect(normalized.rankings_mensais[11]).toEqual({ mes: 12, valor_original: '5', ranking: 5 });
  });

  it('Rk13 is preserved as ranking_extra (no business meaning assumed)', () => {
    const { normalized } = normalizeDisponibilidadeAnualRow(rowWithRks({ Rk13: '7' }), { ano: 2026 });
    expect(normalized.ranking_extra).toEqual({
      key: 'Rk13', valor_original: '7', ranking: 7,
    });
    expect(normalized.rankings_mensais).toEqual([]);
  });

  it('non-numeric ranking value generates warning without breaking', () => {
    const { normalized, validation } = normalizeDisponibilidadeAnualRow(rowWithRks({
      Rk1: 'foo',
      Rk13: 'bar',
    }), { ano: 2026 });

    expect(normalized.rankings_mensais).toEqual([
      { mes: 1, valor_original: 'foo', ranking: null },
    ]);
    expect(normalized.ranking_extra).toEqual({
      key: 'Rk13', valor_original: 'bar', ranking: null,
    });
    const rkWarnings = validation.warnings.filter((w) => w.code === 'RANKING_NON_NUMERIC');
    expect(rkWarnings).toHaveLength(2);
    expect(validation.errors).toEqual([]);
  });

  it('only some Rk columns present — rest stay empty', () => {
    const { normalized } = normalizeDisponibilidadeAnualRow(rowWithRks({
      Rk1: '5', Rk12: '10',
    }), { ano: 2026 });
    expect(normalized.rankings_mensais).toEqual([
      { mes: 1, valor_original: '5', ranking: 5 },
      { mes: 12, valor_original: '10', ranking: 10 },
    ]);
    expect(normalized.ranking_extra).toBeNull();
  });

  it('case-insensitive Rk recognition', () => {
    const { normalized } = normalizeDisponibilidadeAnualRow(rowWithRks({
      rk1: '5', RK13: '7',
    }), { ano: 2026 });
    expect(normalized.rankings_mensais[0]).toEqual({ mes: 1, valor_original: '5', ranking: 5 });
    expect(normalized.ranking_extra?.ranking).toBe(7);
  });
});
