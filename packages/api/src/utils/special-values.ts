import type { SheetRow } from '../services/google-sheets.service.js';
import { sanitizeValue } from './sanitize.js';
import { createSafeRecord } from './safe-keys.js';

/**
 * Process special placeholder values in row data:
 * - TIMESTAMP: replaced with Unix timestamp
 * - DATETIME: replaced with ISO 8601 datetime string
 *
 * Also sanitizes values to prevent formula injection and rejects dangerous
 * keys (`__proto__`, `constructor`, `prototype`) to prevent prototype
 * pollution from user-supplied row data.
 */
export function processSpecialValues(row: SheetRow): SheetRow {
  const result: SheetRow = createSafeRecord<string>();
  const now = new Date();

  for (const [key, value] of Object.entries(row)) {
    // Inline guard against prototype-polluting keys — CodeQL's
    // js/remote-property-injection only recognizes literal string comparisons
    // here, not custom helper functions.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
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
