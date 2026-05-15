import type { RawRow } from '../../normalize/row.js';

export type TargetIssueSeverity = 'info' | 'warning' | 'error';

export interface TargetIssue {
  code: string;
  severity: TargetIssueSeverity;
  message: string;
  field?: string;
}

interface BaseTargetRecord {
  source_row_number: number | null;
  import_hash: string | null;
  issues: TargetIssue[];
}

export interface TargetUsuarios extends BaseTargetRecord {
  target_type: 'usuarios';
  cpf: string;
  nome: string;
  email: string | null;
  telefone: string | null;
  cargo: string | null;
  is_active: boolean;
  grupos: string | null;
}

export interface TargetProdutosControle extends BaseTargetRecord {
  target_type: 'produtos_controle';
  codigo: string | null;
  produto: string;
  quantidade: number;
  municipio: string;
  uf: string;
  data: string;
  uso_das_colecoes: string | null;
}

export interface TargetAgendaSolicitacoes extends BaseTargetRecord {
  target_type: 'agenda_solicitacoes';
  municipio: string;
  uf: string | null;
  projeto: string;
  tipo_evento: string | null;
  data: string;
  hora_inicio: string;
  hora_fim: string;
  coordenador: string | null;
  formador1: string | null;
  formador2: string | null;
  formador3: string | null;
  formador4: string | null;
  formador5: string | null;
  encontro: string | null;
  segmento: string | null;
  local: string | null;
}

export interface TargetDisponibilidadeBloqueios extends BaseTargetRecord {
  target_type: 'disponibilidade_bloqueios';
  usuario: string;
  inicio: string;
  fim: string;
  tipo: 'T' | 'P' | null;
  motivo: string | null;
}

export interface TargetReview extends BaseTargetRecord {
  target_type: 'review';
  source_type: string;
  row_number: number | null;
  reason_codes: string[];
  raw: RawRow;
  normalized: Record<string, unknown>;
  suggested_target: string | null;
}

export type TargetRecord =
  | TargetUsuarios
  | TargetProdutosControle
  | TargetAgendaSolicitacoes
  | TargetDisponibilidadeBloqueios
  | TargetReview;

export type ExportableTargetType =
  | 'usuarios'
  | 'produtos_controle'
  | 'agenda_solicitacoes'
  | 'disponibilidade_bloqueios';

export interface TargetSummary {
  total: number;
  exportable: number;
  review: number;
  invalid: number;
  by_type: Record<string, number>;
  issues_by_code: Record<string, number>;
  warnings_by_code: Record<string, number>;
}

export interface AprenderSistemaTarget {
  name: 'aprender_sistema';
  version: '1.0';
  records: TargetRecord[];
  summary: TargetSummary;
  issues: TargetIssue[]; // target-level issues (not per-record)
}

export const TARGET_NAME = 'aprender_sistema' as const;
export const TARGET_VERSION = '1.0' as const;
