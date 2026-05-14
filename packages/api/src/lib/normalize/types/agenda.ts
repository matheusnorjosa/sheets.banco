import { trimAll, collapseSpaces, uppercaseKey } from '../text.js';
import { parseDateBR, isoCombine } from '../date.js';
import { parseTime, timeAfter } from '../time.js';
import { parseBoolean } from '../boolean.js';
import { parseMunicipio } from '../municipio.js';
import { splitEmails } from '../email.js';
import { RowAccessor, type RawRow } from '../row.js';
import type { ValidationIssue, ValidationResult } from '../../validate/types.js';
import { resolveStatus } from '../../validate/types.js';

export interface NormalizedAgenda {
  ativo: boolean;
  aprovacao: boolean | null;
  atualizar: boolean | null;
  cancelar: boolean | null;
  municipio_original: string;
  municipio: string | null;
  uf: string | null;
  municipio_key: string | null;
  encontro: string;
  tipo: string;
  data: string | null;
  hora_inicio: string | null;
  hora_fim: string | null;
  inicio_iso: string | null;
  fim_iso: string | null;
  projeto_original: string;
  projeto_key: string;
  segmento: string;
  coord_acompanha: boolean | null;
  coordenador_nome: string;
  coordenador_key: string;
  formadores: string[];
  formadores_key: string;
  convidados: string[];
}

export function normalizeAgendaRow(row: RawRow): {
  normalized: NormalizedAgenda;
  validation: ValidationResult;
} {
  const r = new RowAccessor(row);

  const aprovacao = parseBoolean(r.get('Aprovação', 'Aprovacao'));
  const atualizar = parseBoolean(r.get('Atualizar'));
  const cancelar = parseBoolean(r.get('Cancelar', 'C ancelar'));

  const municipio_original = collapseSpaces(trimAll(r.get('Municípios', 'Municipios', 'Município', 'Municipio')));
  const muni = parseMunicipio(municipio_original);

  const encontro = trimAll(r.get('encontro'));
  const tipo = trimAll(r.get('tipo'));

  const data = parseDateBR(r.get('data'));
  const hora_inicio = parseTime(r.get('hora início', 'hora inicio', 'inicio'));
  const hora_fim = parseTime(r.get('hora fim', 'fim'));

  const inicio_iso = data && hora_inicio ? isoCombine(data, hora_inicio) : null;
  const fim_iso = data && hora_fim ? isoCombine(data, hora_fim) : null;

  const projeto_original = collapseSpaces(trimAll(r.get('projeto')));
  const segmento = trimAll(r.get('segmento'));
  const coord_acompanha = parseBoolean(r.get('Coord Acompanha'));
  const coordenador_nome = collapseSpaces(trimAll(r.get('Coordenador')));

  const formadores = ['Formador 1', 'Formador 2', 'Formador 3', 'Formador 4', 'Formador 5']
    .map((k) => collapseSpaces(trimAll(r.get(k))))
    .filter((s) => s.length > 0);

  const convidados = splitEmails(r.get('Convidados'));

  const normalized: NormalizedAgenda = {
    ativo: cancelar !== true,
    aprovacao,
    atualizar,
    cancelar,
    municipio_original,
    municipio: muni.name,
    uf: muni.uf,
    municipio_key: muni.key,
    encontro,
    tipo,
    data,
    hora_inicio,
    hora_fim,
    inicio_iso,
    fim_iso,
    projeto_original,
    projeto_key: uppercaseKey(projeto_original),
    segmento,
    coord_acompanha,
    coordenador_nome,
    coordenador_key: uppercaseKey(coordenador_nome),
    formadores,
    formadores_key: formadores.map(uppercaseKey).sort().join('|'),
    convidados,
  };

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (r.has('data') && !data) {
    errors.push({ code: 'DATE_INVALID', message: 'Data não pôde ser parseada.', field: 'data' });
  }
  if (r.has('hora início', 'hora inicio') && !hora_inicio) {
    errors.push({ code: 'TIME_INVALID', message: 'Hora início inválida.', field: 'hora_inicio' });
  }
  if (r.has('hora fim') && !hora_fim) {
    errors.push({ code: 'TIME_INVALID', message: 'Hora fim inválida.', field: 'hora_fim' });
  }
  if (hora_inicio && hora_fim && !timeAfter(hora_inicio, hora_fim)) {
    errors.push({ code: 'TIME_ORDER', message: 'Hora fim precisa ser maior que hora início.' });
  }

  if (!municipio_original) {
    errors.push({ code: 'MUNICIPALITY_REQUIRED', message: 'Município é obrigatório.', field: 'municipio' });
  } else if (!muni.uf) {
    warnings.push({ code: 'MUNICIPALITY_FORMAT', message: 'Município não está no formato "NOME - UF".', field: 'municipio' });
  }

  if (!projeto_original) {
    errors.push({ code: 'PROJECT_REQUIRED', message: 'Projeto é obrigatório.', field: 'projeto' });
  }

  if (coord_acompanha === true && !coordenador_nome) {
    errors.push({
      code: 'COORDINATOR_REQUIRED',
      message: 'Coordenador obrigatório quando Coord Acompanha = Sim.',
      field: 'coordenador',
    });
  }

  if (cancelar === true) {
    warnings.push({ code: 'EVENT_CANCELED', message: 'Evento marcado como cancelado.' });
  }
  if (atualizar === true) {
    warnings.push({ code: 'EVENT_NEEDS_UPDATE', message: 'Evento marcado para atualização — revisar.' });
  }

  const rawConvidados = r.get('Convidados');
  if (rawConvidados) {
    const splitCount = rawConvidados.split(/[,;\n]/).filter((p) => p.trim()).length;
    if (splitCount !== convidados.length) {
      warnings.push({ code: 'GUEST_EMAIL_INVALID', message: 'Algum convidado tem email mal formado.' });
    }
  }

  let status = resolveStatus(errors, warnings);
  if (cancelar === true && errors.length === 0) status = 'warning';

  return {
    normalized,
    validation: { status, errors, warnings },
  };
}
