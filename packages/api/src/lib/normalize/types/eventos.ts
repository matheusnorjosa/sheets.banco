import { trimAll, collapseSpaces, uppercaseKey, removeAccents } from '../text.js';
import { parseDateBR, isoCombine } from '../date.js';
import { parseTime, timeAfter } from '../time.js';
import { parseMunicipio } from '../municipio.js';
import { normalizeEmail, isEmailValid } from '../email.js';
import { parseBoolean } from '../boolean.js';
import { RowAccessor, type RawRow } from '../row.js';
import type { ValidationIssue, ValidationResult } from '../../validate/types.js';
import { resolveStatus } from '../../validate/types.js';

export interface EventoFlags {
  id_boolean?: boolean;
  titulo_boolean?: boolean;
}

export interface NormalizedEvento {
  external_id: string | null;
  titulo: string | null;
  titulo_key: string | null;
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
  convidados_emails: string[];
  convidados_nomes: string[];
  convidados_invalidos: string[];
  flags: EventoFlags;
}

const CONVIDADO_FIELDS = [
  'convidado1', 'convidado2', 'convidado3', 'convidado4',
  'convidado5', 'convidado6', 'convidado7',
];

const BOOL_TOKENS = new Set(['SIM', 'NAO', 'TRUE', 'FALSE', '1', '0']);

/**
 * Detect when a cell value is one of the recognized boolean tokens
 * (SIM/NÃO/TRUE/FALSE/1/0), regardless of accent or case.
 */
function isBooleanLike(raw: string): boolean {
  if (!raw) return false;
  const key = removeAccents(raw.trim()).toUpperCase();
  return BOOL_TOKENS.has(key);
}

/**
 * A convidado cell is "structurally invalid" when it contains the shape of an
 * email attempt (has an "@") but doesn't pass full email validation, OR when
 * it's clearly garbage (control chars, repeated punctuation only, etc.).
 *
 * Plain text without "@" is treated as a person's name, not invalid.
 */
function looksLikeBrokenEmail(raw: string): boolean {
  if (raw.includes('@')) return true;
  if (!/[a-zA-Z0-9À-ÿ]/.test(raw)) return true; // no alphanumerics at all
  return false;
}

export function normalizeEventoRow(row: RawRow): {
  normalized: NormalizedEvento;
  validation: ValidationResult;
} {
  const r = new RowAccessor(row);

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const flags: EventoFlags = {};

  // --- id / external_id with SIM/NÃO heuristic ----------------------------
  const idRaw = trimAll(r.get('id', 'external_id'));
  let external_id: string | null = idRaw || null;
  if (idRaw && isBooleanLike(idRaw)) {
    flags.id_boolean = parseBoolean(idRaw) ?? false;
    external_id = null;
    warnings.push({
      code: 'SUSPICIOUS_ID_BOOLEAN',
      message: `Coluna "id" contém valor booleano ("${idRaw}") — coluna provavelmente está mal rotulada na planilha.`,
      field: 'id',
    });
  }

  // --- titulo with SIM/NÃO heuristic --------------------------------------
  const tituloRaw = collapseSpaces(trimAll(r.get('titulo')));
  let titulo: string | null = tituloRaw || null;
  let titulo_key: string | null = tituloRaw ? uppercaseKey(tituloRaw) : null;
  const tituloIsBool = tituloRaw && isBooleanLike(tituloRaw);
  if (tituloIsBool) {
    flags.titulo_boolean = parseBoolean(tituloRaw) ?? false;
    titulo = null;
    titulo_key = null;
    warnings.push({
      code: 'SUSPICIOUS_TITLE_BOOLEAN',
      message: `Coluna "titulo" contém valor booleano ("${tituloRaw}") — coluna provavelmente está mal rotulada na planilha.`,
      field: 'titulo',
    });
  }

  // --- município ----------------------------------------------------------
  const municipio_original = collapseSpaces(
    trimAll(r.get('municipio', 'municipios', 'município', 'municípios')),
  );
  const muni = parseMunicipio(municipio_original);

  // --- tipo, ef, data, horas ---------------------------------------------
  const ef = trimAll(r.get('ef', 'encontro'));
  const tipo_original = trimAll(r.get('tipo'));
  const data = parseDateBR(r.get('data'));
  const hora_inicio = parseTime(r.get('inicio', 'início', 'hora início', 'hora inicio'));
  const hora_fim = parseTime(r.get('fim', 'hora fim'));
  const inicio_iso = data && hora_inicio ? isoCombine(data, hora_inicio) : null;
  const fim_iso = data && hora_fim ? isoCombine(data, hora_fim) : null;

  const projeto_original = collapseSpaces(trimAll(r.get('projeto')));
  const segmento = trimAll(r.get('segmento'));

  // --- convidados split into 3 buckets ------------------------------------
  const convidados_emails: string[] = [];
  const convidados_nomes: string[] = [];
  const convidados_invalidos: string[] = [];

  for (const field of CONVIDADO_FIELDS) {
    const raw = trimAll(r.get(field));
    if (!raw) continue;
    const normalized = normalizeEmail(raw);
    if (isEmailValid(normalized)) {
      convidados_emails.push(normalized);
      continue;
    }
    if (looksLikeBrokenEmail(raw)) {
      convidados_invalidos.push(raw);
      warnings.push({
        code: 'GUEST_INVALID_VALUE',
        message: `Convidado "${raw}" parece email mal formado ou conteúdo inválido.`,
        field,
      });
    } else {
      convidados_nomes.push(raw);
      warnings.push({
        code: 'GUEST_NOT_EMAIL',
        message: `Convidado "${raw}" é nome, não email — preencha com email para uso completo.`,
        field,
      });
    }
  }

  const normalized: NormalizedEvento = {
    external_id,
    titulo,
    titulo_key,
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
    convidados_emails,
    convidados_nomes,
    convidados_invalidos,
    flags,
  };

  // --- structural validations --------------------------------------------
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

  // TITLE_REQUIRED only fires when there's no title AND it wasn't a recognized
  // boolean — the boolean warning already conveys "this needs human review".
  if (!titulo && !tituloIsBool) {
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
