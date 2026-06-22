import { trimAll, collapseSpaces, removeAccents, uppercaseKey } from './text.js';

const UF_LIST = new Set([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN',
  'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
]);

export interface MunicipioParsed {
  name: string | null;
  uf: string | null;
  key: string | null;
}

/**
 * Parse a "NOME - UF" string into structured municipality data.
 * Also accepts "NOME/UF" and "NOME (UF)". UF can be provided separately if the
 * input has no UF suffix.
 */
export function parseMunicipio(input: unknown, fallbackUf?: unknown): MunicipioParsed {
  const raw = trimAll(input);
  if (!raw) return { name: null, uf: null, key: null };

  const cleaned = collapseSpaces(raw);
  const fallbackUfClean = uppercaseKey(fallbackUf);

  // "NOME - UF", "NOME-UF", "NOME / UF", "NOME (UF)"
  const patterns = [
    /^(.+?)\s*-\s*([A-Za-z]{2})$/,
    /^(.+?)\s*\/\s*([A-Za-z]{2})$/,
    /^(.+?)\s*\(([A-Za-z]{2})\)$/,
  ];

  for (const re of patterns) {
    const m = cleaned.match(re);
    if (m && m[1] && m[2]) {
      const name = collapseSpaces(m[1]).trim();
      const uf = m[2].toUpperCase();
      if (UF_LIST.has(uf)) {
        return buildResult(name, uf);
      }
    }
  }

  // No embedded UF — use fallback
  if (fallbackUfClean && UF_LIST.has(fallbackUfClean)) {
    return buildResult(cleaned, fallbackUfClean);
  }

  return { name: cleaned, uf: null, key: null };
}

function buildResult(name: string, uf: string): MunicipioParsed {
  const nameKey = removeAccents(name).toUpperCase().replace(/\s+/g, '_');
  return {
    name,
    uf,
    key: `${nameKey}_${uf}`,
  };
}

export function isUfValid(uf: unknown): boolean {
  const u = uppercaseKey(uf);
  return UF_LIST.has(u);
}
