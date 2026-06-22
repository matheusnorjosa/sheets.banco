import { describe, it, expect } from 'vitest';
import { buildAprenderSistemaTarget } from './index.js';
import { envelopeOf } from './test-helpers.js';

describe('aprender_sistema target — disponibilidade_bloqueios', () => {
  it('bloqueios Total → target with tipo=T and isos populated', () => {
    const env = envelopeOf('Bloqueios', [{
      'Usuário': 'Pessoa Exemplo',
      Inicio: '28/02/2026',
      Fim: '02/03/2026',
      Tipo: 'Total',
    }]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0]!;
    expect(r.target_type).toBe('disponibilidade_bloqueios');
    if (r.target_type !== 'disponibilidade_bloqueios') throw new Error('type narrow');
    expect(r).toMatchObject({
      usuario: 'Pessoa Exemplo',
      tipo: 'T',
    });
    expect(r.inicio).toMatch(/^2026-02-28T/);
    expect(r.fim).toMatch(/^2026-03-02T/);
  });

  it('bloqueios Parcial → tipo=P', () => {
    const env = envelopeOf('Bloqueios', [{
      'Usuário': 'X', Inicio: '01/01/2026', Fim: '02/01/2026', Tipo: 'Parcial',
    }]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0]!;
    if (r.target_type !== 'disponibilidade_bloqueios') throw new Error('type narrow');
    expect(r.tipo).toBe('P');
  });

  it('bloqueios tipo=D → review with UNSUPPORTED_BLOCK_TYPE_D, NOT auto-converted', () => {
    const env = envelopeOf('Bloqueios', [{
      'Usuário': 'X', Inicio: '01/01/2026', Fim: '02/01/2026', Tipo: 'D',
    }]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0]!;
    expect(r.target_type).toBe('review');
    if (r.target_type !== 'review') throw new Error('type narrow');
    expect(r.reason_codes).toContain('UNSUPPORTED_BLOCK_TYPE_D');
  });

  it('disponibilidade_mensal → review (no clean direct mapping)', () => {
    const row: Record<string, string> = { Formador: 'Pessoa X' };
    for (let d = 1; d <= 31; d++) row[String(d)] = '';
    const env = envelopeOf('MENSAL MAI 2026', [row]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0]!;
    expect(r.target_type).toBe('review');
    if (r.target_type !== 'review') throw new Error('type narrow');
    expect(r.reason_codes).toContain('MATRIX_REVIEW_REQUIRED');
    expect(r.source_type).toBe('disponibilidade_mensal');
  });

  it('disponibilidade_anual → review', () => {
    const env = envelopeOf('ANUAL 2026', [{
      FORMADOR: 'X',
      'JAN.': '0', 'FEV.': '0', 'MAR.': '0', 'ABR.': '0',
      'MAI.': '0', 'JUN.': '0', 'JUL.': '0', 'AGO.': '0',
      'SET.': '0', 'OUT.': '0', 'NOV.': '0', 'DEZ.': '0',
    }]);
    const t = buildAprenderSistemaTarget(env);
    expect(t.records[0]!.target_type).toBe('review');
  });

  it('deslocamento → review (no stable block contract)', () => {
    const env = envelopeOf('DESLOCAMENTO', [{
      'Município': 'A', 'Tipo': 'Deslocamento', 'Destino': 'B - BA',
      'Data': '11/02/2026', 'Pessoa 1': 'Pessoa X', 'Pessoa 2': 'Pessoa Y',
    }]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0]!;
    expect(r.target_type).toBe('review');
    if (r.target_type !== 'review') throw new Error('type narrow');
    expect(r.reason_codes).toContain('DESLOCAMENTO_NO_STABLE_CONTRACT');
  });
});

describe('aprender_sistema target — unknown sheets', () => {
  it('unknown sheet → review with UNSUPPORTED_SHEET_TYPE', () => {
    const env = envelopeOf('Random', [{ foo: 'bar' }]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0]!;
    expect(r.target_type).toBe('review');
    if (r.target_type !== 'review') throw new Error('type narrow');
    expect(r.reason_codes).toContain('UNSUPPORTED_SHEET_TYPE');
    expect(r.raw).toEqual({ foo: 'bar' });
  });
});
