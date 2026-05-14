import { trimAll, collapseSpaces, uppercaseKey } from '../text.js';
import { cleanCpf, isCpfShapeValid } from '../cpf.js';
import { cleanPhone } from '../phone.js';
import { normalizeEmail, isEmailValid } from '../email.js';
import { RowAccessor, type RawRow } from '../row.js';
import type { ValidationIssue, ValidationResult } from '../../validate/types.js';
import { resolveStatus } from '../../validate/types.js';

export interface NormalizedUser {
  nome: string;
  nome_completo: string;
  cpf: string;
  cpf_key: string;
  telefone: string;
  email: string;
  cargo_original: string;
  cargo_key: string;
  gerencia_original: string;
  gerencia_key: string;
}

export function normalizeUserRow(row: RawRow): {
  normalized: NormalizedUser;
  validation: ValidationResult;
} {
  const r = new RowAccessor(row);

  const nome = collapseSpaces(trimAll(r.get('Nome')));
  const nome_completo = collapseSpaces(trimAll(r.get('Nome Completo', 'Nome completo'))) || nome;
  const cpf = cleanCpf(r.get('CPF'));
  const telefone = cleanPhone(r.get('Telefone', 'Telefone 1', 'Celular'));
  const emailRaw = r.get('Email', 'E-mail');
  const email = normalizeEmail(emailRaw);
  const cargo_original = collapseSpaces(trimAll(r.get('Cargo')));
  const gerencia_original = collapseSpaces(trimAll(r.get('Gerência', 'Gerencia')));

  const normalized: NormalizedUser = {
    nome,
    nome_completo,
    cpf,
    cpf_key: cpf,
    telefone,
    email,
    cargo_original,
    cargo_key: uppercaseKey(cargo_original),
    gerencia_original,
    gerencia_key: uppercaseKey(gerencia_original),
  };

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!cpf) {
    errors.push({ code: 'CPF_REQUIRED', message: 'CPF é obrigatório.', field: 'cpf' });
  } else if (!isCpfShapeValid(cpf)) {
    errors.push({ code: 'CPF_INVALID', message: 'CPF deve conter exatamente 11 dígitos.', field: 'cpf' });
  }

  if (email && !isEmailValid(email)) {
    errors.push({ code: 'EMAIL_INVALID', message: 'Email mal formado.', field: 'email' });
  }

  if (!nome_completo) {
    warnings.push({ code: 'NAME_MISSING', message: 'Nome completo ausente.', field: 'nome_completo' });
  }

  if (!cargo_original) {
    warnings.push({ code: 'CARGO_MISSING', message: 'Cargo não informado.', field: 'cargo' });
  }

  if (!gerencia_original) {
    warnings.push({ code: 'GERENCIA_MISSING', message: 'Gerência não informada.', field: 'gerencia' });
  }

  return {
    normalized,
    validation: { status: resolveStatus(errors, warnings), errors, warnings },
  };
}
