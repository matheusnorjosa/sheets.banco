import { trimAll, collapseSpaces, uppercaseKey } from '../text.js';
import { daysInMonth } from '../month.js';
import { RowAccessor, type RawRow } from '../row.js';
import type { ValidationIssue, ValidationResult } from '../../validate/types.js';
import { resolveStatus } from '../../validate/types.js';

export interface DisponibilidadeSlot {
  dia: number;
  valor_original: string;
  valor_key: string | null;
  data: string | null;
}

export interface NormalizedDisponibilidadeMensal {
  usuario_original: string;
  usuario_key: string;
  periodo: {
    tipo: 'mensal';
    mes: number | null;
    ano: number | null;
  };
  slots: DisponibilidadeSlot[];
}

export interface MensalContext {
  mes: number | null;
  ano: number | null;
}

const USER_FIELD_NAMES = ['Formador', 'Usuário', 'Usuario', 'Nome'];

function findUserKey(row: RawRow): string | null {
  // Prefer explicit name-like headers if they exist.
  for (const cand of USER_FIELD_NAMES) {
    const key = uppercaseKey(cand);
    for (const k of Object.keys(row)) {
      if (uppercaseKey(k) === key) return k;
    }
  }
  // Otherwise the first non-numeric column header that has a value.
  for (const k of Object.keys(row)) {
    const t = k.trim();
    if (!t) continue;
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= 31) continue;
    return k;
  }
  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function normalizeDisponibilidadeMensalRow(
  row: RawRow,
  context: MensalContext = { mes: null, ano: null },
): {
  normalized: NormalizedDisponibilidadeMensal;
  validation: ValidationResult;
} {
  const r = new RowAccessor(row);

  const userKey = findUserKey(row);
  const usuario_original = userKey ? collapseSpaces(trimAll(r.raw(userKey))) : '';

  const slots: DisponibilidadeSlot[] = [];
  const maxDay = context.mes && context.ano ? daysInMonth(context.ano, context.mes) : 31;
  const warnings: ValidationIssue[] = [];
  const errors: ValidationIssue[] = [];

  for (const k of Object.keys(row)) {
    const t = k.trim();
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > 31) continue;
    if (n > maxDay) continue; // skip invalid days for known month (e.g., Feb 30)
    const valor_original = trimAll(row[k]);
    const valor_key = valor_original ? uppercaseKey(valor_original) : null;
    const data = context.mes && context.ano
      ? `${context.ano}-${pad2(context.mes)}-${pad2(n)}`
      : null;
    slots.push({ dia: n, valor_original, valor_key, data });
  }

  slots.sort((a, b) => a.dia - b.dia);

  const normalized: NormalizedDisponibilidadeMensal = {
    usuario_original,
    usuario_key: uppercaseKey(usuario_original),
    periodo: {
      tipo: 'mensal',
      mes: context.mes,
      ano: context.ano,
    },
    slots,
  };

  if (!usuario_original) {
    errors.push({ code: 'USER_REQUIRED', message: 'Usuário é obrigatório.', field: 'usuario' });
  }

  if (context.mes === null || context.ano === null) {
    warnings.push({
      code: 'PERIOD_UNKNOWN',
      message: 'Mês/ano não foram informados — slots ficam sem data resolvida.',
    });
  }

  return {
    normalized,
    validation: { status: resolveStatus(errors, warnings), errors, warnings },
  };
}
