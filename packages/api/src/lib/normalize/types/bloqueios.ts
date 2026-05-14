import { trimAll, collapseSpaces, uppercaseKey } from '../text.js';
import { parseDateBR, isoCombine } from '../date.js';
import { parseTime } from '../time.js';
import { RowAccessor, type RawRow } from '../row.js';
import type { ValidationIssue, ValidationResult } from '../../validate/types.js';
import { resolveStatus } from '../../validate/types.js';

export interface NormalizedBloqueio {
  usuario_original: string;
  usuario_key: string;
  inicio_iso: string | null;
  fim_iso: string | null;
  tipo_original: string;
  tipo_key: string;
}

/**
 * Map raw "Tipo" values to a normalized single-letter key:
 *   "Total", "T", "TOTAL" → "T"
 *   "Parcial", "P", "PARCIAL" → "P"
 *   anything else → uppercased raw, status warning
 */
function normalizeTipoBloqueio(raw: string): string {
  const key = uppercaseKey(raw);
  if (key === 'T' || key === 'TOTAL') return 'T';
  if (key === 'P' || key === 'PARCIAL') return 'P';
  return key;
}

/**
 * Build a full ISO datetime. If the input is a date-only string (no time),
 * combine with `defaultTime` so single-day blocks still have inicio < fim.
 */
function buildIso(rawDateTime: string, defaultTime: string): string | null {
  if (!rawDateTime) return null;

  // Try date + time tuple like "13/11/2023 07:00"
  const dtMatch = rawDateTime.match(/^(.+?)\s+(\d{1,2}:\d{1,2}(?::\d{1,2})?)$/);
  if (dtMatch) {
    const date = parseDateBR(dtMatch[1]);
    const time = parseTime(dtMatch[2]);
    if (date && time) return isoCombine(date, time);
  }

  // Pure date
  const date = parseDateBR(rawDateTime);
  if (date) return isoCombine(date, defaultTime);

  return null;
}

export function normalizeBloqueioRow(row: RawRow): {
  normalized: NormalizedBloqueio;
  validation: ValidationResult;
} {
  const r = new RowAccessor(row);

  const usuario_original = collapseSpaces(trimAll(r.get('Usuário', 'Usuario')));
  const tipo_original = trimAll(r.get('Tipo'));
  const tipo_key = normalizeTipoBloqueio(tipo_original);

  const inicio_raw = trimAll(r.get('Inicio', 'Início', 'inicio', 'início'));
  const fim_raw = trimAll(r.get('Fim', 'fim'));

  // Blocks span whole days: start at 00:00 and end at 23:59:59 so single-day
  // blocks remain valid (inicio_iso < fim_iso).
  const inicio_iso = buildIso(inicio_raw, '00:00:00');
  const fim_iso = buildIso(fim_raw, '23:59:59');

  const normalized: NormalizedBloqueio = {
    usuario_original,
    usuario_key: uppercaseKey(usuario_original),
    inicio_iso,
    fim_iso,
    tipo_original,
    tipo_key,
  };

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!usuario_original) {
    errors.push({ code: 'USER_REQUIRED', message: 'Usuário é obrigatório.', field: 'usuario' });
  }

  if (!inicio_raw) {
    errors.push({ code: 'START_REQUIRED', message: 'Início é obrigatório.', field: 'inicio' });
  } else if (!inicio_iso) {
    errors.push({ code: 'DATE_INVALID', message: 'Início inválido.', field: 'inicio' });
  }

  if (!fim_raw) {
    errors.push({ code: 'END_REQUIRED', message: 'Fim é obrigatório.', field: 'fim' });
  } else if (!fim_iso) {
    errors.push({ code: 'DATE_INVALID', message: 'Fim inválido.', field: 'fim' });
  }

  if (inicio_iso && fim_iso && fim_iso <= inicio_iso) {
    errors.push({ code: 'TIME_ORDER', message: 'Fim precisa ser maior que início.' });
  }

  if (!tipo_original) {
    errors.push({ code: 'TYPE_REQUIRED', message: 'Tipo é obrigatório.', field: 'tipo' });
  } else if (tipo_key === 'D') {
    warnings.push({
      code: 'UNSUPPORTED_BLOCK_TYPE_D',
      message: 'Tipo "D" não é um bloqueio reconhecido — revisar manualmente.',
      field: 'tipo',
    });
  } else if (tipo_key !== 'T' && tipo_key !== 'P') {
    warnings.push({
      code: 'UNKNOWN_BLOCK_TYPE',
      message: `Tipo de bloqueio desconhecido: "${tipo_original}". Aceitos: T, P.`,
      field: 'tipo',
    });
  }

  return {
    normalized,
    validation: { status: resolveStatus(errors, warnings), errors, warnings },
  };
}
