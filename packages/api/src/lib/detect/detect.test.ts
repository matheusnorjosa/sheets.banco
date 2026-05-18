import { describe, it, expect } from 'vitest';
import { buildSheetsWithTypes, detectType } from './index.js';

describe('detectType', () => {
  it('detects users', () => {
    expect(detectType(['Nome', 'Nome Completo', 'CPF', 'Telefone', 'Email', 'Cargo', 'Gerência'])).toBe('users');
  });

  it('detects produtos with F identifier (original sheets)', () => {
    expect(detectType(['F', 'Produto', 'Quant.', 'Município', 'UF', 'Data', 'Uso das coleções'])).toBe('produtos');
  });

  it('detects produtos with id identifier (Controle 🟥 COMPRAS shape)', () => {
    expect(detectType(['id', 'Produto', 'Quant.', 'Município', 'UF', 'Data', 'Uso das coleções'])).toBe('produtos');
  });

  it('detects produtos with Código identifier (accent variant)', () => {
    expect(detectType(['Código', 'Produto', 'Quant.', 'Município', 'UF', 'Data'])).toBe('produtos');
  });

  it('detects produtos with CODIGO identifier (uppercase ascii variant)', () => {
    expect(detectType(['CODIGO', 'Produto', 'Quant.', 'Município', 'UF', 'Data'])).toBe('produtos');
  });

  it('does NOT detect produtos when no identifier column is present', () => {
    expect(detectType(['Produto', 'Quant.', 'Município', 'UF', 'Data'])).toBe('unknown');
  });

  it('does NOT detect produtos when the quantity column is missing', () => {
    expect(detectType(['id', 'Produto', 'Município', 'UF', 'Data'])).toBe('unknown');
  });

  it('detects agenda (spec original com Coordenador)', () => {
    expect(detectType(['Municípios', 'data', 'hora início', 'hora fim', 'projeto', 'Coordenador'])).toBe('agenda');
  });

  it('detects eventos (real schema sem Coordenador)', () => {
    expect(
      detectType([
        'id', 'titulo', 'municipio', 'ef', 'tipo', 'data', 'inicio', 'fim',
        'projeto', 'segmento', 'convidado1', 'convidado2', 'convidado3',
      ]),
    ).toBe('eventos');
  });

  it('detects eventos sem convidados', () => {
    expect(detectType(['titulo', 'municipio', 'data', 'inicio', 'fim', 'projeto'])).toBe('eventos');
  });

  it('detects bloqueios', () => {
    expect(detectType(['Usuário', 'Inicio', 'Fim', 'Tipo'])).toBe('bloqueios');
    expect(detectType(['Usuario', 'Início', 'Fim', 'Tipo'])).toBe('bloqueios');
  });

  it('detects deslocamento (>=2 Pessoa N cols)', () => {
    expect(detectType(['Município', 'Tipo', 'Destino', 'Data', 'Pessoa 1', 'Pessoa 2'])).toBe('deslocamento');
    expect(detectType(['Pessoa 1', 'Pessoa 2', 'Pessoa 3', 'Pessoa 4', 'Pessoa 5', 'Pessoa 6'])).toBe('deslocamento');
  });

  it('detects disponibilidade_anual (month-name headers)', () => {
    expect(
      detectType([
        'FORMADOR', 'JAN.', 'FEV.', 'MAR.', 'ABR.', 'MAI.', 'JUN.',
        'JUL.', 'AGO.', 'SET.', 'OUT.', 'NOV.', 'DEZ.',
      ]),
    ).toBe('disponibilidade_anual');
  });

  it('detects disponibilidade_mensal (numeric day headers 1-31)', () => {
    const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
    expect(detectType(['Formador', ...days])).toBe('disponibilidade_mensal');
  });

  it('detects mensal even when the user column is unconventional', () => {
    const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
    expect(detectType(['MAI.', ...days])).toBe('disponibilidade_mensal');
  });

  it('returns unknown for unrecognized headers', () => {
    expect(detectType(['foo', 'bar', 'baz'])).toBe('unknown');
    expect(detectType([])).toBe('unknown');
    expect(detectType(['Formador', '1', '2'])).toBe('unknown'); // too few day cols
  });

  it('is accent- and case-insensitive', () => {
    expect(detectType(['nome', 'CPF', 'cargo', 'email'])).toBe('users');
  });
});

describe('buildSheetsWithTypes', () => {
  it('zips names and headers, classifying each tab', () => {
    const result = buildSheetsWithTypes(
      ['Usuarios', 'Random', 'Bloqueios'],
      [
        ['Nome', 'CPF', 'Email', 'Cargo'],
        ['foo', 'bar'],
        ['Usuario', 'Início', 'Fim', 'Tipo'],
      ],
    );
    expect(result).toEqual([
      { name: 'Usuarios',  detected_type: 'users',     columns: ['Nome', 'CPF', 'Email', 'Cargo'] },
      { name: 'Random',    detected_type: 'unknown',   columns: ['foo', 'bar'] },
      { name: 'Bloqueios', detected_type: 'bloqueios', columns: ['Usuario', 'Início', 'Fim', 'Tipo'] },
    ]);
  });

  it('treats missing / null header rows as unknown without dropping the tab', () => {
    const result = buildSheetsWithTypes(
      ['Empty', 'AlsoEmpty'],
      [undefined, null],
    );
    expect(result).toEqual([
      { name: 'Empty',     detected_type: 'unknown', columns: [] },
      { name: 'AlsoEmpty', detected_type: 'unknown', columns: [] },
    ]);
  });

  it('coerces non-string header cells (numbers, nulls) to strings', () => {
    // Day-number headers come back from Google as either strings or numbers
    // depending on the cell format. detectType expects strings, so coercion
    // here keeps the contract consistent.
    const days = Array.from({ length: 31 }, (_, i) => i + 1);
    const result = buildSheetsWithTypes(
      ['Mensal'],
      [['Formador', ...(days as unknown as string[])]],
    );
    expect(result[0].detected_type).toBe('disponibilidade_mensal');
    expect(result[0].columns).toEqual(['Formador', ...days.map(String)]);
  });

  it('returns an empty array for an empty name list', () => {
    expect(buildSheetsWithTypes([], [])).toEqual([]);
  });
});
