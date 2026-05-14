import { trimAll, collapseSpaces, uppercaseKey } from '../text.js';
import { parseMonth } from '../month.js';
import { RowAccessor, type RawRow } from '../row.js';
import type { ValidationIssue, ValidationResult } from '../../validate/types.js';
import { resolveStatus } from '../../validate/types.js';

export interface MesAnual {
  mes: number;
  valor_original: string;
  valor_normalizado: number | null;
}

export interface NormalizedDisponibilidadeAnual {
  usuario_original: string;
  usuario_key: string;
  periodo: {
    tipo: 'anual';
    ano: number | null;
  };
  meses: MesAnual[];
  ranking: number | null;
}

export interface AnualContext {
  ano: number | null;
}

const USER_FIELD_NAMES = ['Formador', 'FORMADOR', 'Usuário', 'Usuario', 'Nome'];

function findUserKey(row: RawRow): string | null {
  for (const cand of USER_FIELD_NAMES) {
    const k = uppercaseKey(cand);
    for (const rk of Object.keys(row)) {
      if (uppercaseKey(rk) === k) return rk;
    }
  }
  // Fall back to the first column that isn't a recognizable month.
  for (const rk of Object.keys(row)) {
    if (parseMonth(rk) === null && rk.trim() !== '') return rk;
  }
  return null;
}

function parseNumberValue(raw: string): number | null {
  if (!raw) return null;
  // Brazilian-style "1.234,56" → 1234.56
  const cleaned = raw.replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function normalizeDisponibilidadeAnualRow(
  row: RawRow,
  context: AnualContext = { ano: null },
): {
  normalized: NormalizedDisponibilidadeAnual;
  validation: ValidationResult;
} {
  const r = new RowAccessor(row);

  const userKey = findUserKey(row);
  const usuario_original = userKey ? collapseSpaces(trimAll(r.raw(userKey))) : '';

  const meses: MesAnual[] = [];
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (const k of Object.keys(row)) {
    const m = parseMonth(k);
    if (m === null) continue;
    const valor_original = trimAll(row[k]);
    const valor_normalizado = valor_original ? parseNumberValue(valor_original) : null;
    if (valor_original && valor_normalizado === null) {
      warnings.push({
        code: 'MONTH_VALUE_NON_NUMERIC',
        message: `Valor não numérico no mês ${m}: "${valor_original}".`,
        field: k,
      });
    }
    meses.push({ mes: m, valor_original, valor_normalizado });
  }
  meses.sort((a, b) => a.mes - b.mes);

  // Ranking only when the sheet has a literal "Ranking" column. We deliberately
  // skip Rk1..Rk13 because those look derived (per-month rank).
  const rankingRaw = trimAll(r.get('Ranking'));
  const ranking = rankingRaw ? parseNumberValue(rankingRaw) : null;
  if (rankingRaw && ranking === null) {
    warnings.push({
      code: 'RANKING_NON_NUMERIC',
      message: `Ranking não numérico: "${rankingRaw}".`,
      field: 'ranking',
    });
  }

  const normalized: NormalizedDisponibilidadeAnual = {
    usuario_original,
    usuario_key: uppercaseKey(usuario_original),
    periodo: {
      tipo: 'anual',
      ano: context.ano,
    },
    meses,
    ranking,
  };

  if (!usuario_original) {
    errors.push({ code: 'USER_REQUIRED', message: 'Usuário é obrigatório.', field: 'usuario' });
  }

  if (context.ano === null) {
    warnings.push({
      code: 'PERIOD_UNKNOWN',
      message: 'Ano não foi informado — período fica indefinido.',
    });
  }

  return {
    normalized,
    validation: { status: resolveStatus(errors, warnings), errors, warnings },
  };
}
