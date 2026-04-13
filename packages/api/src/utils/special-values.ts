import type { SheetRow } from '../services/google-sheets.service.js';
import { sanitizeValue } from './sanitize.js';

/**
 * Process special placeholder values in row data:
 * - TIMESTAMP: replaced with Unix timestamp
 * - DATETIME: replaced with ISO 8601 datetime string
 *
 * Also sanitizes values to prevent formula injection.
 */
export function processSpecialValues(row: SheetRow): SheetRow {
  const result: SheetRow = {};
  const now = new Date();

  for (const [key, value] of Object.entries(row)) {
    switch (value) {
      case 'TIMESTAMP':
        result[key] = String(Math.floor(now.getTime() / 1000));
        break;
      case 'DATETIME':
        result[key] = now.toISOString();
        break;
      default:
        result[key] = sanitizeValue(value);
    }
  }

  return result;
}
