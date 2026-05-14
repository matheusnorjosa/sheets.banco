export type ValidationStatus =
  | 'valid'
  | 'warning'
  | 'invalid'
  | 'duplicate'
  | 'needs_review'
  | 'ready_to_import';

export interface ValidationIssue {
  code: string;
  message: string;
  field?: string;
}

export interface ValidationResult {
  status: ValidationStatus;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function emptyResult(): ValidationResult {
  return { status: 'valid', errors: [], warnings: [] };
}

/**
 * Derive a final status from accumulated errors/warnings.
 * Caller can override (e.g. duplicate / needs_review).
 */
export function resolveStatus(errors: ValidationIssue[], warnings: ValidationIssue[]): ValidationStatus {
  if (errors.length > 0) return 'invalid';
  if (warnings.length > 0) return 'warning';
  return 'valid';
}
