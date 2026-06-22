import type { SheetRow } from '../services/google-sheets.service.js';

export type Layout = 'table' | 'raw' | 'matrix';

export function isLayout(value: string | undefined): value is Layout {
  return value === 'table' || value === 'raw' || value === 'matrix';
}

export function applyLayout(
  values: string[][],
  layout: Layout,
): SheetRow[] | string[][] | Record<string, Record<string, string>> {
  if (layout === 'raw') return values;
  if (layout === 'matrix') return toMatrix(values);
  return toTable(values);
}

function toTable(values: string[][]): SheetRow[] {
  if (!values || values.length < 2) return [];
  const headers = (values[0] ?? []).map((h) => String(h ?? ''));
  return values.slice(1).map((row) => {
    const obj: SheetRow = {};
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i] ?? '';
      obj[key] = String(row[i] ?? '');
    }
    return obj;
  });
}

function toMatrix(values: string[][]): Record<string, Record<string, string>> {
  if (!values || values.length < 2) return {};
  const headerRow = values[0] ?? [];
  const colKeys = headerRow.slice(1).map((c) => String(c ?? ''));
  const result: Record<string, Record<string, string>> = {};

  for (let r = 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const rowKey = String(row[0] ?? '');
    if (!rowKey) continue;
    const rowObj: Record<string, string> = {};
    for (let c = 0; c < colKeys.length; c++) {
      const colKey = colKeys[c] ?? '';
      rowObj[colKey] = String(row[c + 1] ?? '');
    }
    result[rowKey] = rowObj;
  }

  return result;
}

/**
 * Validate A1-notation range. Allows refs like "A1:Z100", "A:A", "1:5", "A1".
 * Throws if invalid.
 */
export function sanitizeRange(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (!/^[A-Z]+\d*(?::[A-Z]*\d*)?$|^\d+:\d+$/.test(input)) {
    throw new Error('Invalid range. Use A1 notation (e.g., "A1:Z100", "A:A", "1:5").');
  }
  return input;
}

/**
 * Render-option mapping for Google Sheets API. Friendly param names on the
 * outside, Google's enum values on the wire.
 *
 *   ?render=formatted|unformatted|formula      → valueRenderOption
 *   ?dateTime=serial|string                     → dateTimeRenderOption
 *
 * Both default to undefined when omitted, which makes googleapis fall back
 * to FORMATTED_VALUE + SERIAL_NUMBER (today's effective behaviour) — so
 * existing callers see zero diff. The dateTime option is ignored by Google
 * when the value option is FORMATTED_VALUE.
 */
const VALUE_RENDER_MAP = {
  formatted: 'FORMATTED_VALUE',
  unformatted: 'UNFORMATTED_VALUE',
  formula: 'FORMULA',
} as const;

const DATETIME_RENDER_MAP = {
  serial: 'SERIAL_NUMBER',
  string: 'FORMATTED_STRING',
} as const;

export interface RenderOptions {
  valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
  dateTimeRenderOption?: 'SERIAL_NUMBER' | 'FORMATTED_STRING';
}

/**
 * Parse the starting row number from an A1 range (e.g., "A5:Z100" → 5).
 * Defaults to 1 when no row number is encoded (e.g., column-only "A:A").
 */
export function parseRangeStartRow(range: string | undefined): number {
  if (!range) return 1;
  const m = range.match(/^[A-Z]*(\d+)/);
  return m && m[1] ? parseInt(m[1], 10) : 1;
}

/**
 * Validate `?headerRow=N` — a 1-based row index used to anchor the header
 * row for spreadsheets where it does not live in row 1 (matrix layouts,
 * banner rows, totals at the top, etc.). Returns undefined when the param
 * is absent so the default-of-1 stays implicit.
 *
 * Throws on non-positive integers; out-of-range checks happen later when we
 * know the actual matrix size.
 */
export function parseHeaderRow(input: string | undefined): number | undefined {
  if (input === undefined || input === '') return undefined;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('Invalid headerRow. Must be a positive integer (1-based row index).');
  }
  return n;
}

export function parseRenderOptions(
  render: string | undefined,
  dateTime: string | undefined,
): RenderOptions {
  const out: RenderOptions = {};
  if (render !== undefined && render !== '') {
    const v = VALUE_RENDER_MAP[render as keyof typeof VALUE_RENDER_MAP];
    if (!v) {
      throw new Error(`Invalid render option: "${render}". Use one of: formatted, unformatted, formula.`);
    }
    out.valueRenderOption = v;
  }
  if (dateTime !== undefined && dateTime !== '') {
    const v = DATETIME_RENDER_MAP[dateTime as keyof typeof DATETIME_RENDER_MAP];
    if (!v) {
      throw new Error(`Invalid dateTime option: "${dateTime}". Use one of: serial, string.`);
    }
    out.dateTimeRenderOption = v;
  }
  return out;
}
