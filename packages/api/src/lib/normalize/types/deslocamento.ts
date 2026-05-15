import { trimAll, collapseSpaces, uppercaseKey } from '../text.js';
import { parseDateBR } from '../date.js';
import { parseMunicipio, type MunicipioParsed } from '../municipio.js';
import { RowAccessor, type RawRow } from '../row.js';
import type { ValidationIssue, ValidationResult } from '../../validate/types.js';
import { resolveStatus } from '../../validate/types.js';

export interface PessoaRef {
  nome_original: string;
  nome_key: string;
}

export interface NormalizedDeslocamento {
  pessoas: PessoaRef[];
  pessoas_key: string;
  data: string | null;
  data_original: string;
  origem_original: string;
  origem: string | null;
  origem_uf: string | null;
  origem_key: string | null;
  destino_original: string;
  destino: string | null;
  destino_uf: string | null;
  destino_key: string | null;
  tipo_original: string;
  tipo_key: string;
  observacao: string;
}

const PESSOA_FIELDS = [
  'Pessoa 1', 'Pessoa 2', 'Pessoa 3', 'Pessoa 4', 'Pessoa 5', 'Pessoa 6',
];

function flattenMunicipio(m: MunicipioParsed) {
  return {
    name: m.name,
    uf: m.uf,
    key: m.key,
  };
}

export function normalizeDeslocamentoRow(row: RawRow): {
  normalized: NormalizedDeslocamento;
  validation: ValidationResult;
} {
  const r = new RowAccessor(row);

  // Collect Pessoa N fields, skipping empties.
  const pessoas: PessoaRef[] = [];
  for (const field of PESSOA_FIELDS) {
    const nome_original = collapseSpaces(trimAll(r.get(field)));
    if (!nome_original) continue;
    pessoas.push({ nome_original, nome_key: uppercaseKey(nome_original) });
  }

  const origem_original = collapseSpaces(trimAll(r.get('Município', 'Municipio', 'Origem')));
  const destino_original = collapseSpaces(trimAll(r.get('Destino')));
  const origemParsed = parseMunicipio(origem_original);
  const destinoParsed = parseMunicipio(destino_original);

  const origem = flattenMunicipio(origemParsed);
  const destino = flattenMunicipio(destinoParsed);

  const data_original = trimAll(r.get('Data'));
  const data = parseDateBR(data_original);

  const tipo_original = trimAll(r.get('Tipo'));
  const observacao = collapseSpaces(trimAll(r.get('Observação', 'Observacao', 'Obs')));

  const normalized: NormalizedDeslocamento = {
    pessoas,
    pessoas_key: pessoas.map((p) => p.nome_key).sort().join('|'),
    data,
    data_original,
    origem_original,
    origem: origem.name,
    origem_uf: origem.uf,
    origem_key: origem.key,
    destino_original,
    destino: destino.name,
    destino_uf: destino.uf,
    destino_key: destino.key,
    tipo_original,
    tipo_key: uppercaseKey(tipo_original),
    observacao,
  };

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (pessoas.length === 0) {
    errors.push({ code: 'PESSOA_REQUIRED', message: 'Pelo menos uma pessoa é obrigatória.', field: 'pessoas' });
  }

  // Date is informational only — Data may be "11/02" (no year) in real sheets,
  // so missing/invalid is a warning, not an error.
  if (data_original && !data) {
    warnings.push({
      code: 'DATE_INCOMPLETE',
      message: `Data "${data_original}" não pôde ser parseada como dd/mm/yyyy.`,
      field: 'data',
    });
  }

  // Soft warnings for missing optional context — caller can decide if it matters.
  if (!origem_original) {
    warnings.push({ code: 'ORIGIN_MISSING', message: 'Origem não informada.', field: 'origem' });
  }
  if (!destino_original) {
    warnings.push({ code: 'DESTINATION_MISSING', message: 'Destino não informado.', field: 'destino' });
  }

  return {
    normalized,
    validation: { status: resolveStatus(errors, warnings), errors, warnings },
  };
}
