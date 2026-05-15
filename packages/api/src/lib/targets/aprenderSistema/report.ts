import type { AprenderSistemaTarget } from './types.js';
import { TARGET_NAME } from './types.js';

export interface AprenderSistemaReport {
  target: typeof TARGET_NAME;
  total_records: number;
  exportable_records: number;
  review_records: number;
  invalid_records: number;
  by_type: Record<string, number>;
  issues_by_code: Record<string, number>;
  warnings_by_code: Record<string, number>;
  generated_at: string;
}

/**
 * Convert a built target into a flat report object suitable for the
 * `/report?target=aprender_sistema` endpoint. No PII, only counts.
 */
export function buildAprenderSistemaReport(target: AprenderSistemaTarget): AprenderSistemaReport {
  const s = target.summary;
  return {
    target: TARGET_NAME,
    total_records: s.total,
    exportable_records: s.exportable,
    review_records: s.review,
    invalid_records: s.invalid,
    by_type: { ...s.by_type },
    issues_by_code: { ...s.issues_by_code },
    warnings_by_code: { ...s.warnings_by_code },
    generated_at: new Date().toISOString(),
  };
}
