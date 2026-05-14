import { describe, it, expect } from 'vitest';
import { buildEnvelope, rowsFromValues } from './build.js';

describe('rowsFromValues', () => {
  it('uses first row as headers and skips empty rows', () => {
    const rows = rowsFromValues([
      ['Nome', 'Idade'],
      ['Alice', '30'],
      ['', ''],
      ['Bob', '25'],
    ]);
    expect(rows).toEqual([
      { Nome: 'Alice', Idade: '30' },
      { Nome: 'Bob', Idade: '25' },
    ]);
  });

  it('returns empty when no data rows', () => {
    expect(rowsFromValues([['only', 'headers']])).toEqual([]);
    expect(rowsFromValues([])).toEqual([]);
  });

  it('synthesizes column keys when header is empty', () => {
    const rows = rowsFromValues([
      ['', 'B', ''],
      ['x', 'y', 'z'],
    ]);
    expect(rows[0]).toEqual({ col_1: 'x', B: 'y', col_3: 'z' });
  });
});

describe('buildEnvelope', () => {
  it('produces structured envelope for users sheet', () => {
    const env = buildEnvelope({
      apiId: 'api-1',
      apiName: 'Test API',
      sheets: [
        {
          name: 'Usuários',
          rows: [
            { Nome: 'Alice', 'Nome Completo': 'Alice Doe', CPF: '12345678901', Telefone: '85999999999', Email: 'a@b.com', Cargo: 'Formadores', 'Gerência': 'Superintendência' },
          ],
        },
      ],
    });

    expect(env.schema_version).toBe('1.0');
    expect(env.document.id).toBe('api-1');
    expect(env.document.records_count).toBe(1);
    expect(env.sheets[0].detected_type).toBe('users');
    expect(env.records).toHaveLength(1);

    const rec = env.records[0];
    expect(rec.source.sheet_name).toBe('Usuários');
    expect(rec.source.row_number).toBe(2);
    expect(rec.source.row_hash).toMatch(/^sha256:/);
    expect(rec.raw).toEqual({
      Nome: 'Alice', 'Nome Completo': 'Alice Doe', CPF: '12345678901',
      Telefone: '85999999999', Email: 'a@b.com', Cargo: 'Formadores', 'Gerência': 'Superintendência',
    });
    expect(rec.normalized.cpf).toBe('12345678901');
    expect(rec.validation.status).toBe('valid');
    expect(rec.import_hash).toMatch(/^sha256:/);
  });

  it('handles unknown sheet types per spec', () => {
    const env = buildEnvelope({
      apiId: 'api-1',
      apiName: 'Test',
      sheets: [{ name: 'Calendário', rows: [{ Dia: '1', Cor: 'azul' }] }],
    });
    expect(env.sheets[0].detected_type).toBe('unknown');
    const rec = env.records[0];
    expect(rec.normalized).toEqual({});
    expect(rec.import_hash).toBeNull();
    expect(rec.source.row_hash).toMatch(/^sha256:/); // row_hash still generated
    expect(rec.validation.status).toBe('warning');
    expect(rec.validation.warnings[0].code).toBe('UNSUPPORTED_SHEET_TYPE');
    expect(rec.raw).toEqual({ Dia: '1', Cor: 'azul' });
  });

  it('flags duplicates by import_hash', () => {
    const dupRow = {
      F: '1', Produto: 'X', 'Quant.': '10', 'Município': 'Felixlandia', UF: 'MG', Data: '01/01/2024',
    };
    const env = buildEnvelope({
      apiId: 'api-1',
      apiName: 'Test',
      sheets: [{ name: 'Controle', rows: [dupRow, { ...dupRow }] }],
    });
    expect(env.records[0].validation.status).toBe('duplicate');
    expect(env.records[1].validation.status).toBe('duplicate');
    expect(env.summary.duplicate_records).toBe(2);
  });

  it('counts records by status in summary', () => {
    const env = buildEnvelope({
      apiId: 'api-1',
      apiName: 'Test',
      sheets: [
        {
          name: 'Users',
          rows: [
            { Nome: 'A', CPF: '12345678901', Email: 'a@b.com', Cargo: 'X', 'Gerência': 'Y' }, // valid
            { Nome: 'B', CPF: '', Email: 'b@b.com', Cargo: 'X', 'Gerência': 'Y' }, // invalid (no CPF)
          ],
        },
      ],
    });
    expect(env.summary.total_records).toBe(2);
    expect(env.summary.valid_records).toBe(1);
    expect(env.summary.invalid_records).toBe(1);
    expect(env.summary.errors_by_code.CPF_REQUIRED).toBe(1);
  });
});
