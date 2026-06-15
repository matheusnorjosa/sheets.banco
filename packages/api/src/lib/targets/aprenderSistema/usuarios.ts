import type { EnvelopeRecord } from '../../envelope/build.js';
import type { NormalizedUser } from '../../normalize/types/users.js';
import type { TargetRecord, TargetIssue } from './types.js';
import { buildReviewRecord } from './review.js';

/**
 * Transform a single users envelope record into a target record.
 * Returns a review record when the underlying data is unusable for direct
 * import (e.g. invalid validation status — typically missing CPF).
 */
export function adaptUsuariosRecord(rec: EnvelopeRecord): TargetRecord {
  if (rec.validation.status === 'invalid') {
    return buildReviewRecord(rec, 'users', { suggested_target: 'usuarios' });
  }

  const n = rec.normalized as unknown as NormalizedUser;
  const issues: TargetIssue[] = [];

  // Surface upstream warnings as target issues so consumers see them.
  for (const w of rec.validation.warnings) {
    issues.push({ code: w.code, severity: 'warning', message: w.message, field: w.field });
  }

  // We deliberately do not infer grupos from cargo — a wrong mapping would
  // grant wrong permissions in the destination system. Flag it as info so the
  // consumer (or a future catalog) can fill it in.
  if (n.cargo_original && !issues.find((i) => i.code === 'GROUP_MAPPING_REQUIRED')) {
    issues.push({
      code: 'GROUP_MAPPING_REQUIRED',
      severity: 'info',
      message: 'cargo presente mas sem mapa para grupos/RBAC — preencher manualmente no destino.',
      field: 'grupos',
    });
  }

  return {
    target_type: 'usuarios',
    cpf: n.cpf,
    nome: n.nome_completo || n.nome,
    email: n.email || null,
    telefone: n.telefone || null,
    cargo: n.cargo_original || null,
    is_active: true,
    grupos: null,
    source_row_number: rec.source.row_number ?? null,
    import_hash: rec.import_hash,
    issues,
  };
}

/**
 * Cross-record pass: tag every target usuarios record sharing a CPF with the
 * DUPLICATE_CPF issue. Idempotent — safe to call repeatedly.
 */
export function tagDuplicateCpfs(records: TargetRecord[]): void {
  const seen = new Map<string, number>();
  for (const r of records) {
    if (r.target_type !== 'usuarios') continue;
    if (!r.cpf) continue;
    seen.set(r.cpf, (seen.get(r.cpf) ?? 0) + 1);
  }
  for (const r of records) {
    if (r.target_type !== 'usuarios') continue;
    if (!r.cpf) continue;
    if ((seen.get(r.cpf) ?? 0) <= 1) continue;
    if (!r.issues.find((i) => i.code === 'DUPLICATE_CPF')) {
      r.issues.push({
        code: 'DUPLICATE_CPF',
        severity: 'warning',
        message: `CPF ${r.cpf} aparece em mais de uma linha — revisar antes de importar.`,
        field: 'cpf',
      });
    }
  }
}
