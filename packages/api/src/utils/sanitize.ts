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
 */
export function sanitizeRow(row: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}
