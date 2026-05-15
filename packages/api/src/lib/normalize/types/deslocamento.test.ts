import { describe, it, expect } from 'vitest';
import { normalizeDeslocamentoRow } from './deslocamento.js';

describe('normalizeDeslocamentoRow', () => {
  it('normalizes typical row with origem/destino/data', () => {
    const { normalized, validation } = normalizeDeslocamentoRow({
      'Município': 'Cidade Origem',
      'Tipo': 'Deslocamento',
      'Destino': 'Cidade Destino - BA',
      'Data': '11/02/2026',
      'Pessoa 1': 'Pessoa A',
      'Pessoa 2': 'Pessoa B',
      'Pessoa 3': '',
    });
    expect(normalized.pessoas).toEqual([
      { nome_original: 'Pessoa A', nome_key: 'PESSOA A' },
      { nome_original: 'Pessoa B', nome_key: 'PESSOA B' },
    ]);
    expect(normalized.pessoas_key).toBe('PESSOA A|PESSOA B');
    expect(normalized.data).toBe('2026-02-11');
    expect(normalized.tipo_original).toBe('Deslocamento');
    expect(normalized.destino).toBe('Cidade Destino');
    expect(normalized.destino_uf).toBe('BA');
    expect(validation.status).toBe('valid');
  });

  it('warns when date is incomplete (no year)', () => {
    const { validation } = normalizeDeslocamentoRow({
      'Município': 'X',
      'Destino': 'Y',
      'Data': '11/02',
      'Pessoa 1': 'Pessoa A',
    });
    expect(validation.warnings.some((w) => w.code === 'DATE_INCOMPLETE')).toBe(true);
    expect(validation.status).toBe('warning');
  });

  it('errors when no pessoas', () => {
    const { validation } = normalizeDeslocamentoRow({
      'Município': 'X',
      'Destino': 'Y',
      'Data': '01/01/2026',
    });
    expect(validation.errors.some((e) => e.code === 'PESSOA_REQUIRED')).toBe(true);
  });

  it('removes empty pessoas from array', () => {
    const { normalized } = normalizeDeslocamentoRow({
      'Pessoa 1': 'X',
      'Pessoa 2': '',
      'Pessoa 3': 'Y',
      'Pessoa 4': '   ',
      'Pessoa 5': 'Z',
      'Município': 'A',
      'Destino': 'B',
    });
    expect(normalized.pessoas.map((p) => p.nome_original)).toEqual(['X', 'Y', 'Z']);
  });
});
