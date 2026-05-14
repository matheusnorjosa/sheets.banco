import { describe, it, expect } from 'vitest';
import { normalizeUserRow } from './users.js';

describe('normalizeUserRow', () => {
  it('normalizes typical row', () => {
    const { normalized, validation } = normalizeUserRow({
      Nome: 'Adriana Pinheiro',
      'Nome Completo': 'Adriana Pinheiro Rodrigues',
      CPF: '410.022.453-20',
      Telefone: '(85) 99614-0660',
      Email: 'Adrianaprodrigues9@Gmail.com',
      Cargo: 'Formadores',
      'Gerência': 'Superintendência',
    });
    expect(normalized).toMatchObject({
      nome: 'Adriana Pinheiro',
      nome_completo: 'Adriana Pinheiro Rodrigues',
      cpf: '41002245320',
      cpf_key: '41002245320',
      telefone: '85996140660',
      email: 'adrianaprodrigues9@gmail.com',
      cargo_original: 'Formadores',
      cargo_key: 'FORMADORES',
      gerencia_original: 'Superintendência',
      gerencia_key: 'SUPERINTENDENCIA',
    });
    expect(validation.status).toBe('valid');
    expect(validation.errors).toEqual([]);
  });

  it('errors when CPF is missing', () => {
    const { validation } = normalizeUserRow({ Nome: 'Foo', CPF: '' });
    expect(validation.status).toBe('invalid');
    expect(validation.errors.some((e) => e.code === 'CPF_REQUIRED')).toBe(true);
  });

  it('errors when CPF has wrong length', () => {
    const { validation } = normalizeUserRow({ CPF: '123' });
    expect(validation.errors.some((e) => e.code === 'CPF_INVALID')).toBe(true);
  });

  it('errors on malformed email', () => {
    const { validation } = normalizeUserRow({ CPF: '12345678901', Email: 'broken' });
    expect(validation.errors.some((e) => e.code === 'EMAIL_INVALID')).toBe(true);
  });

  it('warns when cargo/gerência missing', () => {
    const { validation } = normalizeUserRow({ CPF: '12345678901', Email: 'a@b.com' });
    expect(validation.warnings.some((w) => w.code === 'CARGO_MISSING')).toBe(true);
    expect(validation.warnings.some((w) => w.code === 'GERENCIA_MISSING')).toBe(true);
  });
});
