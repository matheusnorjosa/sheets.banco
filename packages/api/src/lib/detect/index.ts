import { uppercaseKey } from '../normalize/text.js';

export type SheetType = 'users' | 'produtos' | 'agenda' | 'unknown';

/**
 * Detect the type of a sheet from its column headers.
 * Comparisons are accent- and case-insensitive.
 */
export function detectType(headers: string[]): SheetType {
  const keys = new Set(headers.map((h) => uppercaseKey(h)).filter(Boolean));

  if (hasAll(keys, ['CPF', 'CARGO', 'EMAIL'])) return 'users';

  if (
    hasAll(keys, ['F', 'PRODUTO', 'MUNICIPIO']) &&
    (keys.has('QUANT.') || keys.has('QUANT') || keys.has('QUANTIDADE'))
  ) {
    return 'produtos';
  }

  if (
    (keys.has('MUNICIPIOS') || keys.has('MUNICIPIO')) &&
    keys.has('DATA') &&
    (keys.has('HORA INICIO') || keys.has('HORA INÍCIO') || keys.has('INICIO') || keys.has('INÍCIO')) &&
    (keys.has('HORA FIM') || keys.has('FIM')) &&
    keys.has('PROJETO') &&
    keys.has('COORDENADOR')
  ) {
    return 'agenda';
  }

  return 'unknown';
}

function hasAll(keys: Set<string>, required: string[]): boolean {
  return required.every((r) => keys.has(r));
}
