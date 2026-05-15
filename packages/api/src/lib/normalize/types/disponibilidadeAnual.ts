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

export interface RankingMensal {
  mes: number;
  valor_original: string;
  ranking: number | null;
}

export interface RankingExtra {
  key: string;
  valor_original: string;
  ranking: number | null;
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
  rankings_mensais: RankingMensal[];
  ranking_extra: RankingExtra | null;
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

/**
 * Match a header to a Rk<N> ranking column.
 * Returns N for Rk1..Rk13, otherwise null. Case- and whitespace-tolerant.
 */
function parseRkColumn(header: string): number | null {
  const m = header.trim().match(/^Rk(\d{1,2})$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 13) return null;
  return n;
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
  const rankings_mensais: RankingMensal[] = [];
  let ranking_extra: RankingExtra | null = null;
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

  // Rk1..Rk12 map to months 1..12 as per-month ranking. Rk13 is intentionally
  // preserved as "ranking_extra" — its semantics aren't confirmed (could be
  // overall ranking, could be something else).
  for (const k of Object.keys(row)) {
    const rk = parseRkColumn(k);
    if (rk === null) continue;
    const valor_original = trimAll(row[k]);
    const ranking = valor_original ? parseNumberValue(valor_original) : null;
    if (valor_original && ranking === null) {
      warnings.push({
        code: 'RANKING_NON_NUMERIC',
        message: `Ranking não numérico em ${k}: "${valor_original}".`,
        field: k,
      });
    }
    if (rk <= 12) {
      rankings_mensais.push({ mes: rk, valor_original, ranking });
    } else {
      // Rk13 — preserved without business meaning.
      ranking_extra = { key: k.trim(), valor_original, ranking };
    }
  }
  rankings_mensais.sort((a, b) => a.mes - b.mes);

  // Ranking literal column (legacy single-value field). Kept for back-compat.
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
    rankings_mensais,
    ranking_extra,
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
