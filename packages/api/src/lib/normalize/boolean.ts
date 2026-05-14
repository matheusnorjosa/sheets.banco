/**
 * Parse a string into a boolean.
 * Accepts SIM/NÃO/TRUE/FALSE/1/0/YES/NO (case- and accent-insensitive).
 * Empty/missing input returns null (unknown).
 */
export function parseBoolean(input: unknown): boolean | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!s) return null;

  if (['sim', 'true', '1', 'yes', 'y', 's', 'x', 'ok'].includes(s)) return true;
  if (['nao', 'false', '0', 'no', 'n', ''].includes(s)) return false;

  return null;
}
