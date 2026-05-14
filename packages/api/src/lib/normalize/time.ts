/**
 * Parse a time string like "07:00", "07:00:00", "7:5" into HH:MM:SS.
 * Returns null if invalid.
 */
export function parseTime(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;

  const match = s.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return null;

  const h = Number(match[1]);
  const m = Number(match[2]);
  const sec = match[3] ? Number(match[3]) : 0;

  if (h < 0 || h > 23) return null;
  if (m < 0 || m > 59) return null;
  if (sec < 0 || sec > 59) return null;

  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Return true if end > start (HH:MM:SS strings, same day).
 */
export function timeAfter(start: string, end: string): boolean {
  return end > start;
}
