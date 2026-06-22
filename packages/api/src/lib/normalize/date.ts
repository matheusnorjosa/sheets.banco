/**
 * Parse a Brazilian date string (dd/mm/yyyy) into ISO YYYY-MM-DD.
 * Returns null if invalid.
 * Also accepts already-ISO strings.
 */
export function parseDateBR(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;

  // Already ISO YYYY-MM-DD?
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return validDate(Number(y), Number(m), Number(d)) ? `${y}-${m}-${d}` : null;
  }

  // dd/mm/yyyy or dd-mm-yyyy or dd.mm.yyyy
  const brMatch = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (brMatch) {
    const [, d, m, yRaw] = brMatch as [string, string, string, string];
    const y = yRaw.length === 2 ? (Number(yRaw) > 50 ? '19' : '20') + yRaw : yRaw;
    const dn = Number(d);
    const mn = Number(m);
    const yn = Number(y);
    if (!validDate(yn, mn, dn)) return null;
    return `${yn}-${String(mn).padStart(2, '0')}-${String(dn).padStart(2, '0')}`;
  }

  return null;
}

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Quick check via Date — catches Feb 30 etc.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Build an ISO timestamp combining a YYYY-MM-DD date and an HH:MM:SS time,
 * using the given timezone offset (defaults to -03:00 / America/Sao_Paulo).
 */
export function isoCombine(dateIso: string, timeHMS: string, tz = '-03:00'): string {
  return `${dateIso}T${timeHMS}${tz}`;
}
