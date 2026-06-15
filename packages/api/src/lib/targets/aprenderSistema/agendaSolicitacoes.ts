import type { EnvelopeRecord } from '../../envelope/build.js';
import type { NormalizedEvento } from '../../normalize/types/eventos.js';
import type { NormalizedAgenda } from '../../normalize/types/agenda.js';
import type { TargetRecord, TargetIssue } from './types.js';
import { buildReviewRecord } from './review.js';

const CRITICAL_REVIEW_CODES = new Set([
  'SUSPICIOUS_TITLE_BOOLEAN', // titulo veio como SIM/NÃO — bloqueia importação até revisão
]);

/**
 * Adapt an `eventos` envelope record to the agenda_solicitacoes target.
 *
 * Note: `eventos` has convidado1..7 fields but NO Coordenador / Formador N
 * columns. So we never auto-populate formadores from convidados — the consumer
 * needs to make that call. We surface the situation as issues instead.
 */
export function adaptEventosRecord(rec: EnvelopeRecord): TargetRecord {
  if (rec.validation.status === 'invalid') {
    return buildReviewRecord(rec, 'eventos', { suggested_target: 'agenda_solicitacoes' });
  }

  const n = rec.normalized as unknown as NormalizedEvento;

  // SIM/NÃO leaking into titulo means the spreadsheet schema is wrong; the
  // resulting record would be confusing in the destination — route to review.
  if (n.flags.titulo_boolean !== undefined) {
    return buildReviewRecord(rec, 'eventos', {
      suggested_target: 'agenda_solicitacoes',
      extra_reasons: ['SUSPICIOUS_TITLE_BOOLEAN'],
    });
  }

  const issues: TargetIssue[] = [];
  for (const w of rec.validation.warnings) {
    if (CRITICAL_REVIEW_CODES.has(w.code)) continue; // already routed above
    issues.push({ code: w.code, severity: 'warning', message: w.message, field: w.field });
  }

  // eventos lacks a coordenador column — always note the gap so importers can
  // backfill or accept null.
  issues.push({
    code: 'COORDINATOR_REVIEW_REQUIRED',
    severity: 'info',
    message: 'A aba "eventos" não tem coluna Coordenador — confirmar manualmente no destino.',
    field: 'coordenador',
  });

  // convidados (emails) are NOT imported as guests — that's a separate calendar
  // concern outside this PR's scope.
  if (n.convidados_emails.length > 0) {
    issues.push({
      code: 'GUESTS_NOT_IMPORTED',
      severity: 'info',
      message: 'Convidados por email não são importados pela agenda — esta PR não publica no Google Calendar.',
      field: 'convidados',
    });
  }

  // Names in convidados might be formadores (or just attendees). Don't guess —
  // surface a review hint and leave formador1..5 null.
  if (n.convidados_nomes.length > 0) {
    issues.push({
      code: 'FORMADOR_REVIEW_REQUIRED',
      severity: 'warning',
      message: `Convidados por nome detectados (${n.convidados_nomes.length}) — verificar se algum é formador no destino.`,
      field: 'formador1',
    });
  }

  return {
    target_type: 'agenda_solicitacoes',
    municipio: n.municipio ?? n.municipio_original,
    uf: n.uf,
    projeto: n.projeto_original,
    tipo_evento: n.tipo_original || null,
    data: n.data ?? '',
    hora_inicio: n.hora_inicio ?? '',
    hora_fim: n.hora_fim ?? '',
    coordenador: null,
    formador1: null,
    formador2: null,
    formador3: null,
    formador4: null,
    formador5: null,
    encontro: n.ef || null,
    segmento: n.segmento || null,
    local: null,
    source_row_number: rec.source.row_number ?? null,
    import_hash: rec.import_hash,
    issues,
  };
}

/**
 * Adapt a legacy `agenda` envelope record (spec schema with Coordenador and
 * Formador 1..5) to the agenda_solicitacoes target.
 */
export function adaptAgendaLegacyRecord(rec: EnvelopeRecord): TargetRecord {
  if (rec.validation.status === 'invalid') {
    return buildReviewRecord(rec, 'agenda', { suggested_target: 'agenda_solicitacoes' });
  }

  const n = rec.normalized as unknown as NormalizedAgenda;
  const issues: TargetIssue[] = [];

  for (const w of rec.validation.warnings) {
    issues.push({ code: w.code, severity: 'warning', message: w.message, field: w.field });
  }

  if (n.convidados.length > 0) {
    issues.push({
      code: 'GUESTS_NOT_IMPORTED',
      severity: 'info',
      message: 'Convidados por email não são importados pela agenda — esta PR não publica no Google Calendar.',
      field: 'convidados',
    });
  }

  return {
    target_type: 'agenda_solicitacoes',
    municipio: n.municipio ?? n.municipio_original,
    uf: n.uf,
    projeto: n.projeto_original,
    tipo_evento: n.tipo || null,
    data: n.data ?? '',
    hora_inicio: n.hora_inicio ?? '',
    hora_fim: n.hora_fim ?? '',
    coordenador: n.coordenador_nome || null,
    formador1: n.formadores[0] ?? null,
    formador2: n.formadores[1] ?? null,
    formador3: n.formadores[2] ?? null,
    formador4: n.formadores[3] ?? null,
    formador5: n.formadores[4] ?? null,
    encontro: n.encontro || null,
    segmento: n.segmento || null,
    local: null,
    source_row_number: rec.source.row_number ?? null,
    import_hash: rec.import_hash,
    issues,
  };
}
