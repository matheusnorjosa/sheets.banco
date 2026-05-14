export function trimAll(input: unknown): string {
  if (input === null || input === undefined) return '';
  return String(input).trim();
}

export function collapseSpaces(input: string): string {
  return input.replace(/\s+/g, ' ');
}

export function removeAccents(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Build a normalized join/lookup key from text:
 * trim → collapse spaces → remove accents → uppercase.
 */
export function uppercaseKey(input: unknown): string {
  const s = trimAll(input);
  if (!s) return '';
  return removeAccents(collapseSpaces(s)).toUpperCase();
}
