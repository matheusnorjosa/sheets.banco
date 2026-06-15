import type { EnvelopeRecord } from '../../envelope/build.js';
import type { NormalizedBloqueio } from '../../normalize/types/bloqueios.js';
import type { TargetRecord, TargetIssue } from './types.js';
import { buildReviewRecord } from './review.js';

/**
 * Adapt a `bloqueios` envelope record to the disponibilidade_bloqueios target.
 * Routes to review when:
 *   - validation is invalid
 *   - tipo is "D" (we don't auto-convert D into T or P)
 *   - tipo is otherwise unrecognized
 */
export function adaptBloqueiosRecord(rec: EnvelopeRecord): TargetRecord {
  if (rec.validation.status === 'invalid') {
    return buildReviewRecord(rec, 'bloqueios', { suggested_target: 'disponibilidade_bloqueios' });
  }

  const n = rec.normalized as unknown as NormalizedBloqueio;

  if (n.tipo_key === 'D') {
    return buildReviewRecord(rec, 'bloqueios', {
      suggested_target: 'disponibilidade_bloqueios',
      extra_reasons: ['UNSUPPORTED_BLOCK_TYPE_D'],
    });
  }
  if (n.tipo_key !== 'T' && n.tipo_key !== 'P') {
    return buildReviewRecord(rec, 'bloqueios', {
      suggested_target: 'disponibilidade_bloqueios',
      extra_reasons: ['UNKNOWN_BLOCK_TYPE'],
    });
  }

  const issues: TargetIssue[] = [];
  for (const w of rec.validation.warnings) {
    issues.push({ code: w.code, severity: 'warning', message: w.message, field: w.field });
  }

  return {
    target_type: 'disponibilidade_bloqueios',
    usuario: n.usuario_original,
    inicio: n.inicio_iso ?? '',
    fim: n.fim_iso ?? '',
    tipo: n.tipo_key,
    motivo: null,
    source_row_number: rec.source.row_number ?? null,
    import_hash: rec.import_hash,
    issues,
  };
}

/**
 * Matrix availability rows have no clean direct mapping to bloqueios — they
 * encode events/travel/absence per day for a person. We send everything to
 * review with the right reason code so a future PR can decide on the contract.
 */
export function adaptDisponibilidadeMatrizRecord(
  rec: EnvelopeRecord,
  sourceType: 'disponibilidade_mensal' | 'disponibilidade_anual',
): TargetRecord {
  return buildReviewRecord(rec, sourceType, {
    suggested_target: 'disponibilidade_bloqueios',
    extra_reasons: ['MATRIX_REVIEW_REQUIRED'],
  });
}

/**
 * Travel rows are not blocks. They could imply unavailability windows but
 * the contract isn't stable enough yet — review them.
 */
export function adaptDeslocamentoRecord(rec: EnvelopeRecord): TargetRecord {
  return buildReviewRecord(rec, 'deslocamento', {
    suggested_target: 'disponibilidade_bloqueios',
    extra_reasons: ['DESLOCAMENTO_NO_STABLE_CONTRACT'],
  });
}
