import type {
  AprenderSistemaTarget,
  TargetAgendaSolicitacoes,
  TargetDisponibilidadeBloqueios,
  TargetIssue,
  TargetProdutosControle,
  TargetRecord,
  TargetReview,
  TargetUsuarios,
} from './types.js';
import { TARGET_NAME } from './types.js';

export type ExportType =
  | 'usuarios'
  | 'produtos_controle'
  | 'agenda_solicitacoes'
  | 'disponibilidade_bloqueios'
  | 'review';

export const EXPORT_TYPES: ReadonlyArray<ExportType> = [
  'usuarios',
  'produtos_controle',
  'agenda_solicitacoes',
  'disponibilidade_bloqueios',
  'review',
];

const RFC4180_NEEDS_QUOTING = /[",\r\n]/;
const CRLF = '\r\n';

/**
 * Escape a single CSV field per RFC 4180. Nulls/undefined become empty;
 * objects/arrays are JSON-stringified so review rows can carry raw/normalized
 * blobs without breaking the row shape.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  let str: string;
  if (typeof value === 'string') str = value;
  else if (typeof value === 'number' || typeof value === 'boolean') str = String(value);
  else str = JSON.stringify(value);

  if (RFC4180_NEEDS_QUOTING.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function rowsToCsv(headers: string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const lines: string[] = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }
  return lines.join(CRLF) + CRLF;
}

function joinIssueCodes(issues: TargetIssue[]): string {
  return issues.map((i) => i.code).join(';');
}

function filterByType<T extends TargetRecord>(
  records: TargetRecord[],
  type: T['target_type'],
): T[] {
  return records.filter((r): r is T => r.target_type === type);
}

export const USUARIOS_HEADERS = [
  'cpf', 'nome', 'email', 'telefone', 'cargo', 'is_active', 'grupos', 'issues',
] as const;

export function usuariosRows(records: TargetRecord[]): unknown[][] {
  return filterByType<TargetUsuarios>(records, 'usuarios').map((r) => [
    r.cpf,
    r.nome,
    r.email,
    r.telefone,
    r.cargo,
    r.is_active,
    r.grupos,
    joinIssueCodes(r.issues),
  ]);
}

export const PRODUTOS_CONTROLE_HEADERS = [
  'CÓD', 'Produto', 'Quant.', 'Município', 'UF', 'Data', 'Uso das coleções', 'issues',
] as const;

export function produtosControleRows(records: TargetRecord[]): unknown[][] {
  return filterByType<TargetProdutosControle>(records, 'produtos_controle').map((r) => [
    r.codigo,
    r.produto,
    r.quantidade,
    r.municipio,
    r.uf,
    r.data,
    r.uso_das_colecoes,
    joinIssueCodes(r.issues),
  ]);
}

export const AGENDA_SOLICITACOES_HEADERS = [
  'municipio', 'uf', 'projeto', 'tipo_evento', 'data', 'hora_inicio', 'hora_fim',
  'coordenador', 'formador1', 'formador2', 'formador3', 'formador4', 'formador5',
  'encontro', 'segmento', 'local', 'issues',
] as const;

export function agendaSolicitacoesRows(records: TargetRecord[]): unknown[][] {
  return filterByType<TargetAgendaSolicitacoes>(records, 'agenda_solicitacoes').map((r) => [
    r.municipio,
    r.uf,
    r.projeto,
    r.tipo_evento,
    r.data,
    r.hora_inicio,
    r.hora_fim,
    r.coordenador,
    r.formador1,
    r.formador2,
    r.formador3,
    r.formador4,
    r.formador5,
    r.encontro,
    r.segmento,
    r.local,
    joinIssueCodes(r.issues),
  ]);
}

export const DISPONIBILIDADE_BLOQUEIOS_HEADERS = [
  'usuario', 'inicio', 'fim', 'tipo', 'motivo', 'issues',
] as const;

export function disponibilidadeBloqueiosRows(records: TargetRecord[]): unknown[][] {
  return filterByType<TargetDisponibilidadeBloqueios>(records, 'disponibilidade_bloqueios').map((r) => [
    r.usuario,
    r.inicio,
    r.fim,
    r.tipo,
    r.motivo,
    joinIssueCodes(r.issues),
  ]);
}

export const REVIEW_HEADERS = [
  'source_type', 'row_number', 'reason_codes', 'suggested_target', 'import_hash', 'raw', 'normalized',
] as const;

export function reviewRows(records: TargetRecord[]): unknown[][] {
  return filterByType<TargetReview>(records, 'review').map((r) => [
    r.source_type,
    r.row_number,
    r.reason_codes.join(';'),
    r.suggested_target,
    r.import_hash,
    JSON.stringify(r.raw),
    JSON.stringify(r.normalized),
  ]);
}

export function buildTargetCsv(target: AprenderSistemaTarget, type: ExportType): string {
  switch (type) {
    case 'usuarios':
      return rowsToCsv([...USUARIOS_HEADERS], usuariosRows(target.records));
    case 'produtos_controle':
      return rowsToCsv([...PRODUTOS_CONTROLE_HEADERS], produtosControleRows(target.records));
    case 'agenda_solicitacoes':
      return rowsToCsv([...AGENDA_SOLICITACOES_HEADERS], agendaSolicitacoesRows(target.records));
    case 'disponibilidade_bloqueios':
      return rowsToCsv([...DISPONIBILIDADE_BLOQUEIOS_HEADERS], disponibilidadeBloqueiosRows(target.records));
    case 'review':
      return rowsToCsv([...REVIEW_HEADERS], reviewRows(target.records));
  }
}

export function isExportType(value: unknown): value is ExportType {
  return typeof value === 'string' && (EXPORT_TYPES as ReadonlyArray<string>).includes(value);
}

/**
 * Build a Content-Disposition filename of the form
 *   aprender_sistema_<type>_<apiId>.csv
 * with apiId stripped to a safe ASCII subset so headers stay valid.
 */
export function buildCsvFilename(type: ExportType, apiId: string): string {
  const safeApiId = apiId.replace(/[^A-Za-z0-9_-]/g, '') || 'api';
  return `aprender_sistema_${type}_${safeApiId}.csv`;
}

export type CsvExportFailureCode =
  | 'TARGET_REQUIRED'
  | 'UNSUPPORTED_TARGET'
  | 'EXPORT_TYPE_REQUIRED'
  | 'UNSUPPORTED_EXPORT_TYPE';

export type CsvExportValidation =
  | { ok: true; type: ExportType }
  | { ok: false; code: CsvExportFailureCode; message: string };

/**
 * Validate the query params for /export.csv. Returned as a discriminated union
 * so the HTTP layer maps failures onto AppError without this module knowing
 * about Fastify.
 */
export function validateCsvExportQuery(query: { target?: string; type?: string }): CsvExportValidation {
  if (!query.target) {
    return {
      ok: false,
      code: 'TARGET_REQUIRED',
      message: `Missing target. Use ?target=${TARGET_NAME}.`,
    };
  }
  if (query.target !== TARGET_NAME) {
    return {
      ok: false,
      code: 'UNSUPPORTED_TARGET',
      message: `Unsupported target: "${query.target}". Available: ${TARGET_NAME}.`,
    };
  }
  if (!query.type) {
    return {
      ok: false,
      code: 'EXPORT_TYPE_REQUIRED',
      message: `Missing type. Available: ${EXPORT_TYPES.join(', ')}.`,
    };
  }
  if (!isExportType(query.type)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_EXPORT_TYPE',
      message: `Unsupported export type: "${query.type}". Available: ${EXPORT_TYPES.join(', ')}.`,
    };
  }
  return { ok: true, type: query.type };
}
