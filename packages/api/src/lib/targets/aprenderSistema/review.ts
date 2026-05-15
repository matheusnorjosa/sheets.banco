import type { EnvelopeRecord } from '../../envelope/build.js';
import type { TargetReview, TargetIssue } from './types.js';

/**
 * Build a generic review record. Preserves raw + normalized intact so a human
 * can inspect them later. `reason_codes` is built from validation issues
 * plus any extra codes the caller supplies.
 */
export function buildReviewRecord(
  rec: EnvelopeRecord,
  sourceType: string,
  options: {
    suggested_target?: string | null;
    extra_reasons?: string[];
  } = {},
): TargetReview {
  const reasons = new Set<string>();
  for (const e of rec.validation.errors) reasons.add(e.code);
  for (const w of rec.validation.warnings) reasons.add(w.code);
  for (const extra of options.extra_reasons ?? []) reasons.add(extra);

  const issues: TargetIssue[] = [];
  for (const e of rec.validation.errors) {
    issues.push({ code: e.code, severity: 'error', message: e.message, field: e.field });
  }
  for (const w of rec.validation.warnings) {
    issues.push({ code: w.code, severity: 'warning', message: w.message, field: w.field });
  }
  for (const extra of options.extra_reasons ?? []) {
    if (!issues.find((i) => i.code === extra)) {
      issues.push({ code: extra, severity: 'warning', message: 'Marked for review.' });
    }
  }

  return {
    target_type: 'review',
    source_type: sourceType,
    row_number: rec.source.row_number ?? null,
    reason_codes: Array.from(reasons).sort(),
    raw: rec.raw,
    normalized: rec.normalized,
    suggested_target: options.suggested_target ?? null,
    source_row_number: rec.source.row_number ?? null,
    import_hash: rec.import_hash,
    issues,
  };
}
