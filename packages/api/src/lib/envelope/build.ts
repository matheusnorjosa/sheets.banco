import { detectType, type SheetType } from '../detect/index.js';
import { normalizeUserRow } from '../normalize/types/users.js';
import { normalizeProdutoRow } from '../normalize/types/produtos.js';
import { normalizeAgendaRow } from '../normalize/types/agenda.js';
import { rowHash, importHash } from '../hash/index.js';
import type { RawRow } from '../normalize/row.js';
import type { ValidationResult, ValidationStatus } from '../validate/types.js';

export const SCHEMA_VERSION = '1.0';

export interface EnvelopeRecord {
  source: {
    sheet_name: string;
    row_number: number;
    row_hash: string;
  };
  raw: RawRow;
  normalized: Record<string, unknown>;
  validation: ValidationResult;
  matches: Record<string, unknown>;
  import_hash: string | null;
}

export interface EnvelopeSheetInfo {
  name: string;
  detected_type: SheetType;
  rows_count: number;
  columns: string[];
}

export interface Envelope {
  schema_version: string;
  document: {
    id: string;
    source_name: string;
    generated_at: string;
    records_count: number;
  };
  sheets: EnvelopeSheetInfo[];
  summary: {
    total_records: number;
    valid_records: number;
    warning_records: number;
    invalid_records: number;
    needs_review_records: number;
    duplicate_records: number;
    detected_types: Record<SheetType, number>;
    errors_by_code: Record<string, number>;
    warnings_by_code: Record<string, number>;
  };
  records: EnvelopeRecord[];
}

export interface SheetInput {
  name: string;
  rows: RawRow[];
}

/**
 * Convert a 2D string matrix into row objects keyed by the first row's headers.
 * Empty header cells produce keys like "col_3" so values are still accessible
 * via /export and remain visible in `raw`.
 */
export function rowsFromValues(values: string[][]): RawRow[] {
  if (!values || values.length < 2) return [];
  const headers = (values[0] ?? []).map((h, i) => {
    const trimmed = String(h ?? '').trim();
    return trimmed || `col_${i + 1}`;
  });
  const out: RawRow[] = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const obj: RawRow = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = String(row[c] ?? '');
    }
    // Skip rows that are entirely empty
    if (Object.values(obj).every((v) => v === '')) continue;
    out.push(obj);
  }
  return out;
}

interface NormalizedOutput {
  normalized: Record<string, unknown>;
  validation: ValidationResult;
}

function normalizeRowByType(type: SheetType, row: RawRow): NormalizedOutput {
  switch (type) {
    case 'users': {
      const r = normalizeUserRow(row);
      return { normalized: r.normalized as unknown as Record<string, unknown>, validation: r.validation };
    }
    case 'produtos': {
      const r = normalizeProdutoRow(row);
      return { normalized: r.normalized as unknown as Record<string, unknown>, validation: r.validation };
    }
    case 'agenda': {
      const r = normalizeAgendaRow(row);
      return { normalized: r.normalized as unknown as Record<string, unknown>, validation: r.validation };
    }
    case 'unknown':
    default:
      return {
        normalized: {},
        validation: {
          status: 'warning',
          errors: [],
          warnings: [
            {
              code: 'UNSUPPORTED_SHEET_TYPE',
              message: 'Tipo de planilha não reconhecido. Dados brutos preservados.',
            },
          ],
        },
      };
  }
}

export function buildEnvelope(params: {
  apiId: string;
  apiName: string;
  sheets: SheetInput[];
}): Envelope {
  const sheetsInfo: EnvelopeSheetInfo[] = [];
  const allRecords: EnvelopeRecord[] = [];
  const detectedTypeCounts: Record<SheetType, number> = {
    users: 0,
    produtos: 0,
    agenda: 0,
    unknown: 0,
  };

  for (const sheet of params.sheets) {
    const columns = sheet.rows[0] ? Object.keys(sheet.rows[0]) : [];
    const type = detectType(columns);
    sheetsInfo.push({
      name: sheet.name,
      detected_type: type,
      rows_count: sheet.rows.length,
      columns,
    });

    for (let i = 0; i < sheet.rows.length; i++) {
      const raw = sheet.rows[i];
      const { normalized, validation } = normalizeRowByType(type, raw);
      const rHash = rowHash(raw);
      const iHash = importHash(type, type === 'unknown' ? null : (normalized as never));

      allRecords.push({
        source: {
          sheet_name: sheet.name,
          row_number: i + 2, // +2: header is row 1, data starts at row 2
          row_hash: rHash,
        },
        raw,
        normalized,
        validation,
        matches: {},
        import_hash: iHash,
      });
    }
  }

  // Cross-record pass: mark duplicates by import_hash
  const hashCount = new Map<string, number>();
  for (const rec of allRecords) {
    if (!rec.import_hash) continue;
    hashCount.set(rec.import_hash, (hashCount.get(rec.import_hash) ?? 0) + 1);
  }
  for (const rec of allRecords) {
    if (rec.import_hash && (hashCount.get(rec.import_hash) ?? 0) > 1) {
      if (rec.validation.status === 'valid' || rec.validation.status === 'warning') {
        rec.validation = {
          ...rec.validation,
          status: 'duplicate',
        };
      }
    }
  }

  for (const sheet of sheetsInfo) {
    detectedTypeCounts[sheet.detected_type]++;
  }

  // Summary stats
  const summary = {
    total_records: allRecords.length,
    valid_records: 0,
    warning_records: 0,
    invalid_records: 0,
    needs_review_records: 0,
    duplicate_records: 0,
    detected_types: detectedTypeCounts,
    errors_by_code: {} as Record<string, number>,
    warnings_by_code: {} as Record<string, number>,
  };

  for (const rec of allRecords) {
    incrementStatusCount(summary, rec.validation.status);
    for (const e of rec.validation.errors) {
      summary.errors_by_code[e.code] = (summary.errors_by_code[e.code] ?? 0) + 1;
    }
    for (const w of rec.validation.warnings) {
      summary.warnings_by_code[w.code] = (summary.warnings_by_code[w.code] ?? 0) + 1;
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    document: {
      id: params.apiId,
      source_name: params.apiName,
      generated_at: new Date().toISOString(),
      records_count: allRecords.length,
    },
    sheets: sheetsInfo,
    summary,
    records: allRecords,
  };
}

function incrementStatusCount(summary: Envelope['summary'], status: ValidationStatus): void {
  switch (status) {
    case 'valid':
    case 'ready_to_import':
      summary.valid_records++;
      break;
    case 'warning':
      summary.warning_records++;
      break;
    case 'invalid':
      summary.invalid_records++;
      break;
    case 'needs_review':
      summary.needs_review_records++;
      break;
    case 'duplicate':
      summary.duplicate_records++;
      break;
  }
}
