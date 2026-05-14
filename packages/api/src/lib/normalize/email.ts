const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(input: unknown): string {
  if (input === null || input === undefined) return '';
  return String(input).trim().toLowerCase();
}

export function isEmailValid(email: string): boolean {
  return EMAIL_RE.test(email);
}

/**
 * Split a comma- or semicolon-separated string of emails into a clean,
 * deduplicated array of lowercase emails. Invalid entries are dropped.
 */
export function splitEmails(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  const parts = String(input)
    .split(/[,;\n]/)
    .map((p) => normalizeEmail(p))
    .filter((p) => p && isEmailValid(p));
  return Array.from(new Set(parts));
}
