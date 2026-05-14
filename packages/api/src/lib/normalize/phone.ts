/**
 * Strip non-digits and a leading "55" country code from a Brazilian phone.
 * Returns the bare 10- or 11-digit number (with DDD).
 */
export function cleanPhone(input: unknown): string {
  if (input === null || input === undefined) return '';
  let digits = String(input).replace(/\D+/g, '');
  if (digits.length === 13 && digits.startsWith('55')) digits = digits.slice(2);
  if (digits.length === 12 && digits.startsWith('55')) digits = digits.slice(2);
  return digits;
}
