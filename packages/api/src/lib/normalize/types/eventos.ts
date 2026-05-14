import { trimAll, collapseSpaces, uppercaseKey } from '../text.js';
import { parseDateBR, isoCombine } from '../date.js';
import { parseTime, timeAfter } from '../time.js';
import { parseMunicipio } from '../municipio.js';
import { normalizeEmail, isEmailValid } from '../email.js';
import { RowAccessor, type RawRow } from '../row.js';
import type { ValidationIssue, ValidationResult } from '../../validate/types.js';
import { resolveStatus } from '../../validate/types.js';

export interface NormalizedEvento {
  external_id: string;
  titulo: string;
  titulo_key: string;
  municipio_original: string;
  municipio: string | null;
  uf: string | null;
  municipio_key: string | null;
  ef: string;
  tipo_original: string;
  tipo_key: string;
  data: string | null;
  hora_inicio: string | null;
  hora_fim: string | null;
  inicio_iso: string | null;
  fim_iso: string | null;
  projeto_original: string;
  projeto_key: string;
  segmento: string;
  convidados: string[];
}

const CONVIDADO_FIELDS = [
  'convidado1', 'convidado2', 'convidado3', 'convidado4',
  'convidado5', 'convidado6', 'convidado7',
];

export function normalizeEventoRow(row: RawRow): {
  normalized: NormalizedEvento;
  validation: ValidationResult;
} {
  const r = new RowAccessor(row);

  const external_id = trimAll(r.get('id', 'external_id'));
  const titulo = collapseSpaces(trimAll(r.get('titulo')));
  const municipio_original = collapseSpaces(trimAll(r.get('municipio', 'municipios', 'município', 'municípios')));
  const muni = parseMunicipio(municipio_original);

  const ef = trimAll(r.get('ef', 'encontro'));
  const tipo_original = trimAll(r.get('tipo'));

  const data = parseDateBR(r.get('data'));
  const hora_inicio = parseTime(r.get('inicio', 'início', 'hora início', 'hora inicio'));
  const hora_fim = parseTime(r.get('fim', 'hora fim'));

  const inicio_iso = data && hora_inicio ? isoCombine(data, hora_inicio) : null;
  const fim_iso = data && hora_fim ? isoCombine(data, hora_fim) : null;

  const projeto_original = collapseSpaces(trimAll(r.get('projeto')));
  const segmento = trimAll(r.get('segmento'));

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Process convidados: each filled cell should be a valid email; warn otherwise.
  const convidados: string[] = [];
  for (const field of CONVIDADO_FIELDS) {
    const raw = trimAll(r.get(field));
    if (!raw) continue;
    const email = normalizeEmail(raw);
    if (isEmailValid(email)) {
      convidados.push(email);
    } else {
      warnings.push({
        code: 'GUEST_NOT_EMAIL',
        message: `Convidado "${raw}" não é um email válido — preencha com email.`,
        field,
      });
    }
  }

  const normalized: NormalizedEvento = {
    external_id,
    titulo,
    titulo_key: uppercaseKey(titulo),
    municipio_original,
    municipio: muni.name,
    uf: muni.uf,
    municipio_key: muni.key,
    ef,
    tipo_original,
    tipo_key: uppercaseKey(tipo_original),
    data,
    hora_inicio,
    hora_fim,
    inicio_iso,
    fim_iso,
    projeto_original,
    projeto_key: uppercaseKey(projeto_original),
    segmento,
    convidados,
  };

  if (r.has('data') && !data) {
    errors.push({ code: 'DATE_INVALID', message: 'Data não pôde ser parseada.', field: 'data' });
  }
  if (r.has('inicio', 'início') && !hora_inicio) {
    errors.push({ code: 'TIME_INVALID', message: 'Início inválido.', field: 'hora_inicio' });
  }
  if (r.has('fim') && !hora_fim) {
    errors.push({ code: 'TIME_INVALID', message: 'Fim inválido.', field: 'hora_fim' });
  }
  if (hora_inicio && hora_fim && !timeAfter(hora_inicio, hora_fim)) {
    errors.push({ code: 'TIME_ORDER', message: 'Fim precisa ser maior que início.' });
  }

  if (!titulo) {
    errors.push({ code: 'TITLE_REQUIRED', message: 'Título é obrigatório.', field: 'titulo' });
  }

  if (!municipio_original) {
    errors.push({ code: 'MUNICIPALITY_REQUIRED', message: 'Município é obrigatório.', field: 'municipio' });
  } else if (!muni.uf) {
    warnings.push({ code: 'MUNICIPALITY_FORMAT', message: 'Município não está no formato "NOME - UF".', field: 'municipio' });
  }

  if (!projeto_original) {
    errors.push({ code: 'PROJECT_REQUIRED', message: 'Projeto é obrigatório.', field: 'projeto' });
  }

  return {
    normalized,
    validation: { status: resolveStatus(errors, warnings), errors, warnings },
  };
}
