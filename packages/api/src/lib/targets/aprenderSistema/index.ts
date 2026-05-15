import type { Envelope, EnvelopeRecord } from '../../envelope/build.js';
import type { SheetType } from '../../detect/index.js';
import type {
  AprenderSistemaTarget,
  TargetRecord,
  TargetSummary,
} from './types.js';
import { TARGET_NAME, TARGET_VERSION } from './types.js';
import { adaptUsuariosRecord, tagDuplicateCpfs } from './usuarios.js';
import { adaptProdutosControleRecord } from './produtosControle.js';
import { adaptEventosRecord, adaptAgendaLegacyRecord } from './agendaSolicitacoes.js';
import {
  adaptBloqueiosRecord,
  adaptDisponibilidadeMatrizRecord,
  adaptDeslocamentoRecord,
} from './disponibilidade.js';
import { buildReviewRecord } from './review.js';

export * from './types.js';

/**
 * Build the aprender_sistema target from an envelope. Each envelope record is
 * routed to the right adapter based on its source sheet's detected_type.
 */
export function buildAprenderSistemaTarget(envelope: Envelope): AprenderSistemaTarget {
  const sheetTypeBySheetName = new Map<string, SheetType>();
  for (const s of envelope.sheets) {
    sheetTypeBySheetName.set(s.name, s.detected_type);
  }

  const records: TargetRecord[] = [];
  for (const rec of envelope.records) {
    records.push(adaptOne(rec, sheetTypeBySheetName.get(rec.source.sheet_name) ?? 'unknown'));
  }

  // Cross-record passes (e.g., duplicate CPF detection).
  tagDuplicateCpfs(records);

  return {
    name: TARGET_NAME,
    version: TARGET_VERSION,
    records,
    summary: buildSummary(records),
    issues: [],
  };
}

function adaptOne(rec: EnvelopeRecord, sourceType: SheetType): TargetRecord {
  switch (sourceType) {
    case 'users':
      return adaptUsuariosRecord(rec);
    case 'produtos':
      return adaptProdutosControleRecord(rec);
    case 'eventos':
      return adaptEventosRecord(rec);
    case 'agenda':
      return adaptAgendaLegacyRecord(rec);
    case 'bloqueios':
      return adaptBloqueiosRecord(rec);
    case 'disponibilidade_mensal':
    case 'disponibilidade_anual':
      return adaptDisponibilidadeMatrizRecord(rec, sourceType);
    case 'deslocamento':
      return adaptDeslocamentoRecord(rec);
    case 'unknown':
    default:
      return buildReviewRecord(rec, 'unknown', {
        suggested_target: null,
        extra_reasons: ['UNSUPPORTED_SHEET_TYPE'],
      });
  }
}

function buildSummary(records: TargetRecord[]): TargetSummary {
  const summary: TargetSummary = {
    total: records.length,
    exportable: 0,
    review: 0,
    invalid: 0,
    by_type: {},
    issues_by_code: {},
    warnings_by_code: {},
  };

  for (const r of records) {
    summary.by_type[r.target_type] = (summary.by_type[r.target_type] ?? 0) + 1;

    if (r.target_type === 'review') {
      summary.review++;
    } else {
      summary.exportable++;
    }

    for (const issue of r.issues) {
      if (issue.severity === 'error') {
        summary.issues_by_code[issue.code] = (summary.issues_by_code[issue.code] ?? 0) + 1;
        summary.invalid++;
      } else if (issue.severity === 'warning') {
        summary.warnings_by_code[issue.code] = (summary.warnings_by_code[issue.code] ?? 0) + 1;
      }
    }
  }

  return summary;
}
