import { uppercaseKey } from '../normalize/text.js';
import { parseMonth } from '../normalize/month.js';

export type SheetType =
  | 'users'
  | 'produtos'
  | 'agenda'
  | 'eventos'
  | 'bloqueios'
  | 'deslocamento'
  | 'disponibilidade_mensal'
  | 'disponibilidade_anual'
  | 'unknown';

/**
 * Detect the type of a sheet from its column headers.
 * Comparisons are accent- and case-insensitive.
 */
export function detectType(headers: string[]): SheetType {
  const rawHeaders = headers.map((h) => String(h ?? ''));
  const keys = new Set(rawHeaders.map(uppercaseKey).filter(Boolean));

  if (hasAll(keys, ['CPF', 'CARGO', 'EMAIL'])) return 'users';

  // Produtos: PRODUTO + MUNICIPIO + a quantity column + any identifier.
  // The historical identifier in the original sheets was "F", but real-world
  // sheets (e.g. the Controle workbook's purchase tab) use "id" or "CÓDIGO"
  // for the same role. RowAccessor.get already accepts ID alongside F/CODIGO
  // on the normalizer side, so this stays consistent end-to-end.
  const hasProdutoIdentifier =
    keys.has('F') || keys.has('ID') || keys.has('CODIGO');
  if (
    hasProdutoIdentifier &&
    hasAll(keys, ['PRODUTO', 'MUNICIPIO']) &&
    (keys.has('QUANT.') || keys.has('QUANT') || keys.has('QUANTIDADE'))
  ) {
    return 'produtos';
  }

  // Original spec "agenda" — Coordenador-based events
  if (
    (keys.has('MUNICIPIOS') || keys.has('MUNICIPIO')) &&
    keys.has('DATA') &&
    (keys.has('HORA INICIO') || keys.has('HORA INÍCIO') || keys.has('INICIO') || keys.has('INÍCIO')) &&
    (keys.has('HORA FIM') || keys.has('FIM')) &&
    keys.has('PROJETO') &&
    keys.has('COORDENADOR')
  ) {
    return 'agenda';
  }

  // "eventos" — real-world events sheet (no Coordenador, convidado1..7 instead)
  if (
    keys.has('TITULO') &&
    keys.has('MUNICIPIO') &&
    keys.has('DATA') &&
    keys.has('INICIO') &&
    keys.has('FIM') &&
    keys.has('PROJETO')
  ) {
    return 'eventos';
  }

  // "bloqueios" — Usuário, Início, Fim, Tipo
  if (
    (keys.has('USUARIO') || keys.has('USUÁRIO')) &&
    (keys.has('INICIO') || keys.has('INÍCIO')) &&
    keys.has('FIM') &&
    keys.has('TIPO')
  ) {
    return 'bloqueios';
  }

  // "deslocamento" — has Pessoa N columns
  const pessoaCount = rawHeaders.filter((h) => /^pessoa\s*\d+$/i.test(h.trim())).length;
  if (pessoaCount >= 2) {
    return 'deslocamento';
  }

  // "disponibilidade_anual" — 10+ Portuguese month-name columns
  const monthCount = rawHeaders.filter((h) => parseMonth(h) !== null).length;
  if (monthCount >= 10) {
    return 'disponibilidade_anual';
  }

  // "disponibilidade_mensal" — at least 25 columns that are day numbers 1-31
  const dayCount = rawHeaders.filter((h) => {
    const n = Number(String(h).trim());
    return Number.isInteger(n) && n >= 1 && n <= 31;
  }).length;
  if (dayCount >= 25) {
    return 'disponibilidade_mensal';
  }

  return 'unknown';
}

function hasAll(keys: Set<string>, required: string[]): boolean {
  return required.every((r) => keys.has(r));
}

export interface SheetWithType {
  name: string;
  /**
   * Numeric Google Sheets ID. Stable across renames — pin consumer configs
   * to this instead of `name` if you want to survive tab renames. Null only
   * when Google's response somehow omits the field.
   */
  sheet_id: number | null;
  /** 0-based position in the spreadsheet, in tab-bar order. */
  sheet_index: number;
  detected_type: SheetType;
  columns: string[];
}

export interface SheetMetadata {
  name: string;
  sheet_id: number | null;
  sheet_index: number;
}

/**
 * Pure mapper used by the typed-discovery endpoint. Takes a list of tab
 * metadata and, in the same order, the first row (headers) fetched for each
 * tab. Missing/short header arrays are treated as empty — the tab is still
 * reported, just classified as `unknown`.
 */
export function buildSheetsWithTypes(
  meta: ReadonlyArray<SheetMetadata>,
  headersByIndex: ReadonlyArray<ReadonlyArray<string> | null | undefined>,
): SheetWithType[] {
  return meta.map((m, i) => {
    const raw = headersByIndex[i] ?? [];
    const columns = raw.map((h) => String(h ?? ''));
    return {
      name: m.name,
      sheet_id: m.sheet_id,
      sheet_index: m.sheet_index,
      detected_type: detectType(columns),
      columns,
    };
  });
}
