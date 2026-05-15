/**
 * Backward-compat + envelope wiring tests for the aprender_sistema target.
 *
 * Pins the contract that:
 *   - `target` only appears when `?target=` is sent
 *   - the existing envelope shape (records, sheets, summary, document) does
 *     not change when `target` is added
 */
import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../../envelope/build.js';
import { buildAprenderSistemaTarget } from './index.js';

const usersSheet = {
  name: 'Usuários',
  rows: [{
    Nome: 'A', 'Nome Completo': 'A Doe', CPF: '12345678901',
    Telefone: '85999999999', Email: 'a@example.com',
    Cargo: 'X', 'Gerência': 'Y',
  }],
};

describe('envelope without target', () => {
  it('keeps its documented top-level keys', () => {
    const env = buildEnvelope({ apiId: 'x', apiName: 'x', sheets: [usersSheet] });
    expect(Object.keys(env).sort()).toEqual(
      ['document', 'records', 'schema_version', 'sheets', 'summary'].sort(),
    );
    expect((env as unknown as { target?: unknown }).target).toBeUndefined();
  });
});

describe('envelope + aprender_sistema target', () => {
  it('attaches a target field with name + version + records + summary', () => {
    const env = buildEnvelope({ apiId: 'x', apiName: 'x', sheets: [usersSheet] });
    const target = buildAprenderSistemaTarget(env);
    expect(target).toMatchObject({
      name: 'aprender_sistema',
      version: '1.0',
    });
    expect(Array.isArray(target.records)).toBe(true);
    expect(target.summary).toMatchObject({
      total: env.records.length,
      by_type: expect.any(Object),
    });
  });

  it('preserves envelope.records untouched when target is built', () => {
    const env = buildEnvelope({ apiId: 'x', apiName: 'x', sheets: [usersSheet] });
    const beforeRaw = JSON.stringify(env.records);
    buildAprenderSistemaTarget(env);
    expect(JSON.stringify(env.records)).toBe(beforeRaw);
  });

  it('target.records[*] always carry target_type', () => {
    const env = buildEnvelope({
      apiId: 'x', apiName: 'x',
      sheets: [
        usersSheet,
        { name: 'Eventos', rows: [{
          titulo: 'X', municipio: 'C - BA', data: '01/01/2026',
          inicio: '07:00', fim: '17:00', projeto: 'P',
        }] },
        { name: 'Random', rows: [{ foo: 'bar' }] },
      ],
    });
    const target = buildAprenderSistemaTarget(env);
    expect(target.records.every((r) => typeof r.target_type === 'string')).toBe(true);
    const types = target.records.map((r) => r.target_type);
    expect(types).toContain('usuarios');
    expect(types).toContain('agenda_solicitacoes');
    expect(types).toContain('review');
  });
});
