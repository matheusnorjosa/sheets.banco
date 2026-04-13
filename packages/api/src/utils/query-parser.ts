import type { SheetRow } from '../services/google-sheets.service.js';

type FilterFn = (row: SheetRow) => boolean;

/**
 * Parse a search value into a filter function.
 *
 * Supported patterns:
 * - "value"     → exact match
 * - "!value"    → negation
 * - ">N"        → greater than
 * - "<N"        → less than
 * - ">=N"       → greater or equal
 * - "<=N"       → less or equal
 * - "val*"      → starts with
 * - "*val"      → ends with
 * - "*val*"     → contains
 */
function parseFilter(column: string, value: string, caseSensitive: boolean): FilterFn {
  const normalize = (v: string) => (caseSensitive ? v : v.toLowerCase());

  // Negation
  if (value.startsWith('!')) {
    const inner = parseFilter(column, value.slice(1), caseSensitive);
    return (row) => !inner(row);
  }

  // Comparison operators (>=, <=, >, <)
  if (value.startsWith('>=')) {
    const num = Number(value.slice(2));
    return (row) => Number(row[column]) >= num;
  }
  if (value.startsWith('<=')) {
    const num = Number(value.slice(2));
    return (row) => Number(row[column]) <= num;
  }
  if (value.startsWith('>')) {
    const num = Number(value.slice(1));
    return (row) => Number(row[column]) > num;
  }
  if (value.startsWith('<')) {
    const num = Number(value.slice(1));
    return (row) => Number(row[column]) < num;
  }

  // Wildcard patterns
  if (value.startsWith('*') && value.endsWith('*') && value.length > 2) {
    const inner = normalize(value.slice(1, -1));
    return (row) => normalize(row[column] ?? '').includes(inner);
  }
  if (value.endsWith('*')) {
    const prefix = normalize(value.slice(0, -1));
    return (row) => normalize(row[column] ?? '').startsWith(prefix);
  }
  if (value.startsWith('*')) {
    const suffix = normalize(value.slice(1));
    return (row) => normalize(row[column] ?? '').endsWith(suffix);
  }

  // Exact match
  return (row) => normalize(row[column] ?? '') === normalize(value);
}

/**
 * Build filter functions from query params.
 * Ignores reserved params (limit, offset, sort_by, sort_order, sheet, casesensitive, cast_numbers, single_object).
 */
const RESERVED_PARAMS = new Set([
  'limit', 'offset', 'sort_by', 'sort_order',
  'sheet', 'casesensitive', 'cast_numbers', 'single_object',
]);

export function buildFilters(
  query: Record<string, string>,
  caseSensitive: boolean,
): FilterFn[] {
  const filters: FilterFn[] = [];

  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_PARAMS.has(key)) continue;
    filters.push(parseFilter(key, value, caseSensitive));
  }

  return filters;
}

/**
 * Apply AND filters — all must match.
 */
export function filterAnd(rows: SheetRow[], filters: FilterFn[]): SheetRow[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) => filters.every((fn) => fn(row)));
}

/**
 * Apply OR filters — at least one must match.
 */
export function filterOr(rows: SheetRow[], filters: FilterFn[]): SheetRow[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) => filters.some((fn) => fn(row)));
}
