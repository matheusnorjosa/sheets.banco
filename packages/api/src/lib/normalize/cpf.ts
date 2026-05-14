/**
 * Strip non-digits from a CPF input.
 * Does NOT validate check digits — that's a separate concern.
 */
export function cleanCpf(input: unknown): string {
  if (input === null || input === undefined) return '';
  return String(input).replace(/\D+/g, '');
}

/**
 * Returns true if the CPF has exactly 11 digits.
 * Does not validate check digits — most spreadsheets contain raw CPF strings
 * with format variations but valid numbers.
 */
export function isCpfShapeValid(cpf: string): boolean {
  return /^\d{11}$/.test(cpf);
}
