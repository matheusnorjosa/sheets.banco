import { describe, it, expect } from 'vitest';
import { rowHash, importHash } from './index.js';

describe('rowHash', () => {
  it('is stable across key reorderings', () => {
    const h1 = rowHash({ a: '1', b: '2' });
    const h2 = rowHash({ b: '2', a: '1' });
    expect(h1).toBe(h2);
  });

  it('changes when values change', () => {
    const h1 = rowHash({ a: '1' });
    const h2 = rowHash({ a: '2' });
    expect(h1).not.toBe(h2);
  });

  it('has sha256: prefix', () => {
    expect(rowHash({ a: '1' })).toMatch(/^sha256:/);
  });
});

describe('importHash', () => {
  it('returns null for unknown type', () => {
    expect(importHash('unknown', null)).toBeNull();
  });

  it('returns null when normalized is null', () => {
    expect(importHash('users', null)).toBeNull();
  });

  it('produces stable hash for users', () => {
    const h = importHash('users', {
      nome: 'A', nome_completo: 'A B', cpf: '12345678901', cpf_key: '12345678901',
      telefone: '', email: 'a@b.com', cargo_original: '', cargo_key: '',
      gerencia_original: '', gerencia_key: '',
    });
    expect(h).toMatch(/^sha256:/);
  });
});
