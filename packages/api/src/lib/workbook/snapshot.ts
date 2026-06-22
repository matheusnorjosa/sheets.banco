import { detectType, type SheetType } from '../detect/index.js';
import { parseHeaderRow, parseRangeStartRow, sanitizeRange } from '../../utils/layout.js';

// Re-export for callers that already import parseRangeStartRow from this module.
export { parseRangeStartRow } from '../../utils/layout.js';

export interface WorkbookRow {
  /** Spreadsheet row number (1-based; header is row 1 unless a range moves it). */
  row_number: number;
  /** Header → cell value, keyed by safe value-keys (see buildValueKeys). */
  values: Record<string, string>;
  /** Cell values in column order, mirrors the headers array length. */
  raw: string[];
}

export interface WorkbookSheetSnapshot {
  sheet_index: number;
  sheet_name: string;
  detected_type: SheetType;
  /** Original header row, exactly as the spreadsheet returned it. */
  headers: string[];
  /** Count of NON-empty data rows actually emitted in `rows`. */
  row_count: number;
  rows: WorkbookRow[];
}

/**
 * Map a header row to stable, unique keys used in WorkbookRow.values.
 *   - Empty/blank headers → `__col_<1-based index>` (e.g., `__col_3`)
 *   - Duplicates get incremental `__2`, `__3` suffixes (the first occurrence
 *     keeps the original name unchanged)
 *
 * The original headers array is NEVER mutated here — only the per-row values
 * dict uses these safe keys. `raw` continues to mirror the original columns.
 */
export function buildValueKeys(headers: ReadonlyArray<string>): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const trimmed = String(h ?? '').trim();
    if (!trimmed) return `__col_${i + 1}`;
    const count = seen.get(trimmed) ?? 0;
    seen.set(trimmed, count + 1);
    return count === 0 ? trimmed : `${trimmed}__${count + 1}`;
  });
}

export interface BuildSnapshotInput {
  sheet_index: number;
  sheet_name: string;
  /** Raw 2D values as returned by sheetsService.getRawValues. */
  values: string[][];
  /** Original A1 range, if any. Used to anchor row_number. */
  range?: string;
  /**
   * 1-based spreadsheet row that holds the header. Defaults to 1 — i.e. the
   * first row of the fetched range. When the range starts at row R and the
   * header is at row H, the header is at matrix index H - R; rows above are
   * banner/title rows and are silently dropped.
   */
  header_row?: number;
}

export type BuildSnapshotResult =
  | { ok: true; snapshot: WorkbookSheetSnapshot }
  | { ok: false; code: 'HEADER_ROW_OUTSIDE_RANGE'; message: string };

/**
 * Build the per-sheet workbook snapshot. Pure function — receives already-
 * fetched values plus metadata, returns the contract object. Drops rows
 * whose every cell is the empty string (mirrors envelope.rowsFromValues
 * behaviour for consistency).
 *
 * Returns a discriminated result so the route layer can map
 * HEADER_ROW_OUTSIDE_RANGE to a 400 without this module knowing about HTTP.
 */
export function buildWorkbookSheetSnapshot(input: BuildSnapshotInput): BuildSnapshotResult {
  const { sheet_index, sheet_name, values, range } = input;
  const startRow = parseRangeStartRow(range);
  const headerRow = input.header_row ?? startRow;
  const headerIndex = headerRow - startRow;

  if (values.length === 0) {
    // Empty matrix — return a coherent empty snapshot regardless of headerRow.
    return {
      ok: true,
      snapshot: {
        sheet_index,
        sheet_name,
        detected_type: 'unknown',
        headers: [],
        row_count: 0,
        rows: [],
      },
    };
  }

  if (headerIndex < 0 || headerIndex >= values.length) {
    return {
      ok: false,
      code: 'HEADER_ROW_OUTSIDE_RANGE',
      message: `headerRow=${headerRow} is not within the fetched data (covers rows ${startRow}..${startRow + values.length - 1}).`,
    };
  }

  const headers = (values[headerIndex] ?? []).map((h) => String(h ?? ''));
  const valueKeys = buildValueKeys(headers);
  const detected_type = detectType(headers);

  const rows: WorkbookRow[] = [];
  for (let i = headerIndex + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const raw: string[] = [];
    const valuesObj: Record<string, string> = {};
    let allEmpty = true;

    for (let c = 0; c < valueKeys.length; c++) {
      const v = String(row[c] ?? '');
      raw.push(v);
      const key = valueKeys[c] ?? `col_${c + 1}`;
      valuesObj[key] = v;
      if (v !== '') allEmpty = false;
    }
    if (allEmpty) continue;

    rows.push({
      row_number: startRow + i,
      values: valuesObj,
      raw,
    });
  }

  return {
    ok: true,
    snapshot: {
      sheet_index,
      sheet_name,
      detected_type,
      headers,
      row_count: rows.length,
      rows,
    },
  };
}

export type WorkbookQueryValidation =
  | { ok: true; sheet: string; range: string | undefined; header_row: number | undefined }
  | { ok: false; code: 'WORKBOOK_SHEET_REQUIRED' | 'VALIDATION_ERROR'; message: string };

/**
 * Validate the per-sheet workbook export query. `sheet` is required; `range`
 * and `headerRow` are optional and go through the shared validators.
 * Returned as a discriminated union so the HTTP layer maps failures onto
 * AppError without this module knowing about Fastify.
 */
export function validateWorkbookQuery(query: { sheet?: string; range?: string; headerRow?: string }): WorkbookQueryValidation {
  if (!query.sheet) {
    return {
      ok: false,
      code: 'WORKBOOK_SHEET_REQUIRED',
      message: 'Missing sheet. Workbook export is per-sheet only — pass ?sheet=<tab name>. Use /sheets?include=types to list available tabs.',
    };
  }
  let range: string | undefined;
  let header_row: number | undefined;
  try {
    range = sanitizeRange(query.range);
  } catch (err) {
    return { ok: false, code: 'VALIDATION_ERROR', message: (err as Error).message };
  }
  try {
    header_row = parseHeaderRow(query.headerRow);
  } catch (err) {
    return { ok: false, code: 'VALIDATION_ERROR', message: (err as Error).message };
  }
  return { ok: true, sheet: query.sheet, range, header_row };
}
