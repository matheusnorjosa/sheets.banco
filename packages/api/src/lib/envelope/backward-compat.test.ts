/**
 * Backward-compatibility contract test.
 *
 * The default response of `GET /api/v1/:apiId` (no `?envelope=v1`) is a flat
 * array of objects, consumed by external projects (projeto.planilha, etc.).
 * This file pins the contract at the data-shaping layer:
 *
 *   - rowsFromValues(values) → RawRow[]                  (legacy default)
 *   - buildEnvelope({...})   → { schema_version, ... }   (opt-in envelope)
 *
 * Changing either shape requires a deliberate version bump.
 */
import { describe, it, expect } from 'vitest';
import { rowsFromValues, buildEnvelope } from './build.js';

describe('backward compatibility contract', () => {
  it('legacy: rowsFromValues stays a flat array of row objects', () => {
    const result = rowsFromValues([
      ['col_a', 'col_b'],
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { col_a: '1', col_b: '2' },
      { col_a: '3', col_b: '4' },
    ]);
    // No envelope wrapper leaks into the legacy shape.
    expect((result as any).schema_version).toBeUndefined();
    expect((result as any).records).toBeUndefined();
  });

  it('envelope=v1: top-level object with the documented keys', () => {
    const env = buildEnvelope({
      apiId: 'x',
      apiName: 'x',
      sheets: [{ name: 'Users', rows: [{
        Nome: 'A', CPF: '12345678901', Email: 'a@b.com', Cargo: 'X', 'Gerência': 'Y',
      }] }],
    });
    expect(env).toMatchObject({
      schema_version: '1.0',
      document: expect.any(Object),
      sheets: expect.any(Array),
      summary: expect.any(Object),
      records: expect.any(Array),
    });
    expect(Array.isArray(env.records)).toBe(true);
  });

  it('envelope.records[*].raw preserves original fields verbatim', () => {
    const raw = {
      Nome: 'A',
      'Nome Completo': 'A Doe',
      CPF: '12345678901',
      Telefone: '85999999999',
      Email: 'a@b.com',
      Cargo: 'X',
      'Gerência': 'Y',
    };
    const env = buildEnvelope({
      apiId: 'x', apiName: 'x',
      sheets: [{ name: 'Users', rows: [raw] }],
    });
    expect(env.records[0]!.raw).toEqual(raw);
  });

  it('envelope produces a row_hash for every record (including unknown types)', () => {
    const env = buildEnvelope({
      apiId: 'x', apiName: 'x',
      sheets: [{ name: 'Mystery', rows: [{ foo: 'bar' }] }],
    });
    expect(env.sheets[0]!.detected_type).toBe('unknown');
    expect(env.records[0]!.source.row_hash).toMatch(/^sha256:/);
    expect(env.records[0]!.import_hash).toBeNull();
  });

  it('keeps users/produtos/agenda detection working (no regression)', () => {
    const users = buildEnvelope({
      apiId: 'x', apiName: 'x',
      sheets: [{ name: 'U', rows: [{
        Nome: 'A', CPF: '12345678901', Email: 'a@b.com', Cargo: 'X', 'Gerência': 'Y',
      }] }],
    });
    const produtos = buildEnvelope({
      apiId: 'x', apiName: 'x',
      sheets: [{ name: 'P', rows: [{
        F: '1', Produto: 'X', 'Quant.': '5', 'Município': 'C', UF: 'BA', Data: '01/01/2026',
      }] }],
    });
    const agenda = buildEnvelope({
      apiId: 'x', apiName: 'x',
      sheets: [{ name: 'A', rows: [{
        'Municípios': 'X - BA', 'data': '01/01/2026', 'hora início': '07:00', 'hora fim': '17:00',
        'projeto': 'P', 'Coordenador': 'C', 'Coord Acompanha': 'NÃO',
      }] }],
    });

    expect(users.sheets[0]!.detected_type).toBe('users');
    expect(produtos.sheets[0]!.detected_type).toBe('produtos');
    expect(agenda.sheets[0]!.detected_type).toBe('agenda');
  });
});
