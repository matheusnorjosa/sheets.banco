import { parseMonth } from '../normalize/month.js';

/**
 * Try to extract a month and/or year from a sheet name.
 * Examples: "MENSAL", "MENSAL 2026", "Disponibilidade MAI 2026", "ANUAL 2026".
 * Returns nulls when the value cannot be inferred.
 */
export function extractPeriodFromSheetName(sheetName: string): {
  mes: number | null;
  ano: number | null;
} {
  let mes: number | null = null;
  let ano: number | null = null;

  const yearMatch = sheetName.match(/\b(20\d{2})\b/);
  if (yearMatch) ano = Number(yearMatch[1]);

  const tokens = sheetName.split(/[\s\-_/|]+/).filter(Boolean);
  for (const tok of tokens) {
    const m = parseMonth(tok);
    if (m !== null) {
      mes = m;
      break;
    }
  }

  return { mes, ano };
}
