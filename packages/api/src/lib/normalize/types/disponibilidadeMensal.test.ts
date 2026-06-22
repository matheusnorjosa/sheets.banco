import { describe, it, expect } from 'vitest';
import { normalizeDisponibilidadeMensalRow } from './disponibilidadeMensal.js';

describe('normalizeDisponibilidadeMensalRow', () => {
  it('builds slots and resolves dates when month/year are known', () => {
    const row: Record<string, string> = {
      Formador: 'Pessoa Exemplo',
      '1': '', '2': 'D', '3': '1', '4': 'P',
    };
    for (let d = 5; d <= 31; d++) row[String(d)] = '';
    const { normalized, validation } = normalizeDisponibilidadeMensalRow(row, { mes: 2, ano: 2026 });

    expect(normalized.usuario_original).toBe('Pessoa Exemplo');
    expect(normalized.usuario_key).toBe('PESSOA EXEMPLO');
    expect(normalized.periodo).toEqual({ tipo: 'mensal', mes: 2, ano: 2026 });
    expect(normalized.slots).toHaveLength(28); // Feb 2026 has 28 days
    expect(normalized.slots[0]).toEqual({
      dia: 1, valor_original: '', valor_key: null, data: '2026-02-01',
    });
    expect(normalized.slots[1]).toEqual({
      dia: 2, valor_original: 'D', valor_key: 'D', data: '2026-02-02',
    });
    expect(validation.status).toBe('valid');
  });

  it('warns when month/year unknown — data stays null', () => {
    const row: Record<string, string> = { Formador: 'X' };
    for (let d = 1; d <= 31; d++) row[String(d)] = '';
    const { normalized, validation } = normalizeDisponibilidadeMensalRow(row);
    expect(validation.warnings.some((w) => w.code === 'PERIOD_UNKNOWN')).toBe(true);
    expect(normalized.slots[0]!.data).toBeNull();
  });

  it('errors when user column is empty', () => {
    const row: Record<string, string> = { Formador: '' };
    for (let d = 1; d <= 31; d++) row[String(d)] = '';
    const { validation } = normalizeDisponibilidadeMensalRow(row, { mes: 1, ano: 2026 });
    expect(validation.errors.some((e) => e.code === 'USER_REQUIRED')).toBe(true);
  });

  it('falls back to first non-numeric column when there is no Formador/Nome', () => {
    const row: Record<string, string> = { 'MAI.': 'Pessoa Y' };
    for (let d = 1; d <= 31; d++) row[String(d)] = '';
    const { normalized } = normalizeDisponibilidadeMensalRow(row, { mes: 5, ano: 2026 });
    expect(normalized.usuario_original).toBe('Pessoa Y');
  });
});
