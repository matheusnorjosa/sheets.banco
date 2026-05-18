import { trimAll, collapseSpaces, uppercaseKey, removeAccents } from '../text.js';
import { parseDateBR } from '../date.js';
import { parseBoolean } from '../boolean.js';
import { parseMunicipio, isUfValid } from '../municipio.js';
import { RowAccessor, type RawRow } from '../row.js';
import type { ValidationIssue, ValidationResult } from '../../validate/types.js';
import { resolveStatus } from '../../validate/types.js';

export interface NormalizedProduto {
  codigo_original: string;
  produto_original: string;
  produto_key: string;
  quantidade: number | null;
  municipio_original: string;
  municipio_key: string | null;
  uf: string | null;
  data: string | null;
  uso_colecao_2026: boolean | null;
}

export function normalizeProdutoRow(row: RawRow): {
  normalized: NormalizedProduto;
  validation: ValidationResult;
} {
  const r = new RowAccessor(row);

  // Real-world identifiers seen so far: "F" (original), "id" (Controle 🟥 COMPRAS),
  // "Código"/"Codigo". RowAccessor.get is case- and accent-insensitive, so any
  // casing of these is matched.
  const codigo_original = trimAll(r.get('F', 'ID', 'Código', 'Codigo'));
  const produto_original = collapseSpaces(trimAll(r.get('Produto')));
  const produto_key = produto_original
    ? removeAccents(produto_original).toUpperCase().replace(/[.;,]/g, '').replace(/\s+/g, ' ').trim()
    : '';

  const quantStr = r.get('Quant.', 'Quant', 'Quantidade');
  const quantNum = quantStr ? Number(String(quantStr).replace(/\./g, '').replace(',', '.')) : NaN;
  const quantidade = Number.isFinite(quantNum) ? quantNum : null;

  const municipio_original = collapseSpaces(trimAll(r.get('Município', 'Municipio')));
  const ufRaw = trimAll(r.get('UF'));
  const muni = parseMunicipio(municipio_original, ufRaw);

  const data = parseDateBR(r.get('Data'));

  const usoStr = r.get('Uso das coleções', 'Uso das colecoes', 'Uso da coleção', 'Uso');
  const uso_colecao_2026 = parseBoolean(usoStr);

  const normalized: NormalizedProduto = {
    codigo_original,
    produto_original,
    produto_key,
    quantidade,
    municipio_original,
    municipio_key: muni.key,
    uf: muni.uf,
    data,
    uso_colecao_2026,
  };

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!produto_original) {
    errors.push({ code: 'PRODUCT_REQUIRED', message: 'Produto é obrigatório.', field: 'produto' });
  }

  if (quantidade === null) {
    errors.push({ code: 'QUANTITY_INVALID', message: 'Quantidade não é numérica.', field: 'quantidade' });
  }

  if (!municipio_original) {
    errors.push({ code: 'MUNICIPALITY_REQUIRED', message: 'Município é obrigatório.', field: 'municipio' });
  } else if (!muni.uf) {
    errors.push({ code: 'UF_INVALID', message: 'UF inválida ou ausente.', field: 'uf' });
  } else if (ufRaw && !isUfValid(ufRaw) && muni.uf !== uppercaseKey(ufRaw)) {
    warnings.push({ code: 'UF_MISMATCH', message: 'UF informada difere da inferida.', field: 'uf' });
  }

  if (r.has('Data') && !data) {
    errors.push({ code: 'DATE_INVALID', message: 'Data não pôde ser parseada.', field: 'data' });
  }

  return {
    normalized,
    validation: { status: resolveStatus(errors, warnings), errors, warnings },
  };
}
