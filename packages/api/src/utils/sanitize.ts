import { createSafeRecord, isSafeKey } from './safe-keys.js';

/**
 * Sanitize cell values to prevent spreadsheet formula injection.
 * Strips leading characters that could trigger formula execution: = + - @ |
 */
export function sanitizeValue(value: string): string {
  if (/^[=+\-@|]/.test(value)) {
    return "'" + value;
  }
  return value;
}

/**
 * Sanitize all values in a row object.
 * Drops dangerous keys (`__proto__`, etc.) to avoid prototype pollution.
 */
export function sanitizeRow(row: Record<string, string>): Record<string, string> {
  const sanitized = createSafeRecord<string>();
  for (const [key, value] of Object.entries(row)) {
    if (!isSafeKey(key)) continue;
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}
