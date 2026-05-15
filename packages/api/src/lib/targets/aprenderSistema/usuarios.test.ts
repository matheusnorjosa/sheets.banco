import { describe, it, expect } from 'vitest';
import { buildAprenderSistemaTarget } from './index.js';
import { envelopeOf } from './test-helpers.js';

const baseUser = {
  Nome: 'Pessoa Um',
  'Nome Completo': 'Pessoa Um da Silva',
  CPF: '12345678901',
  Telefone: '85999999999',
  Email: 'a@example.com',
  Cargo: 'Formadores',
  'Gerência': 'Superintendência',
};

describe('aprender_sistema target — usuarios', () => {
  it('users → target usuarios with normalized fields', () => {
    const env = envelopeOf('Usuários', [baseUser]);
    const t = buildAprenderSistemaTarget(env);

    expect(t.records).toHaveLength(1);
    const r = t.records[0];
    expect(r.target_type).toBe('usuarios');
    if (r.target_type !== 'usuarios') throw new Error('type narrow');
    expect(r).toMatchObject({
      cpf: '12345678901',
      nome: 'Pessoa Um da Silva',
      email: 'a@example.com',
      telefone: '85999999999',
      cargo: 'Formadores',
      is_active: true,
      grupos: null,
    });
    // GROUP_MAPPING_REQUIRED emitted because cargo present but no mapping.
    expect(r.issues.find((i) => i.code === 'GROUP_MAPPING_REQUIRED')).toBeTruthy();
  });

  it('invalid users record (no CPF) → review', () => {
    const env = envelopeOf('Usuários', [{ ...baseUser, CPF: '' }]);
    const t = buildAprenderSistemaTarget(env);
    expect(t.records[0].target_type).toBe('review');
  });

  it('duplicate CPF tagged on every record sharing it', () => {
    const env = envelopeOf('Usuários', [
      baseUser,
      { ...baseUser, Nome: 'Pessoa Dois', Email: 'b@example.com' }, // same CPF
    ]);
    const t = buildAprenderSistemaTarget(env);
    expect(t.records).toHaveLength(2);
    for (const r of t.records) {
      if (r.target_type === 'usuarios') {
        expect(r.issues.find((i) => i.code === 'DUPLICATE_CPF')).toBeTruthy();
      }
    }
  });

  it('does NOT flag duplicate when CPFs differ', () => {
    const env = envelopeOf('Usuários', [
      baseUser,
      { ...baseUser, CPF: '98765432109', Nome: 'Outro' },
    ]);
    const t = buildAprenderSistemaTarget(env);
    for (const r of t.records) {
      if (r.target_type === 'usuarios') {
        expect(r.issues.find((i) => i.code === 'DUPLICATE_CPF')).toBeFalsy();
      }
    }
  });
});
