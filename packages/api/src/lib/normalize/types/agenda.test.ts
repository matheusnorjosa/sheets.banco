import { describe, it, expect } from 'vitest';
import { normalizeAgendaRow } from './agenda.js';

describe('normalizeAgendaRow', () => {
  it('normalizes typical row', () => {
    const { normalized, validation } = normalizeAgendaRow({
      'Aprovação': 'SIM',
      'Atualizar': 'NÃO',
      'Cancelar': 'NÃO',
      'Municípios': 'ITAGI - BA',
      'encontro': '1',
      'tipo': 'Presencial',
      'data': '12/02/2026',
      'hora início': '07:00',
      'hora fim': '17:00',
      'projeto': 'Tema',
      'segmento': '1 e 2',
      'Coord Acompanha': 'SIM',
      'Coordenador': 'Valdemir Silva',
      'Formador 1': 'Hugo Ribeiro',
      'Formador 2': '',
      'Convidados': 'hugoaprendereditora@gmail.com',
    });
    expect(normalized).toMatchObject({
      ativo: true,
      aprovacao: true,
      cancelar: false,
      municipio: 'ITAGI',
      uf: 'BA',
      municipio_key: 'ITAGI_BA',
      data: '2026-02-12',
      hora_inicio: '07:00:00',
      hora_fim: '17:00:00',
      inicio_iso: '2026-02-12T07:00:00-03:00',
      projeto_original: 'Tema',
      projeto_key: 'TEMA',
      coord_acompanha: true,
      coordenador_nome: 'Valdemir Silva',
      formadores: ['Hugo Ribeiro'],
      convidados: ['hugoaprendereditora@gmail.com'],
    });
    expect(validation.status).toBe('valid');
  });

  it('errors when fim <= inicio', () => {
    const { validation } = normalizeAgendaRow({
      'Municípios': 'X - BA', 'data': '01/01/2026', 'hora início': '10:00', 'hora fim': '09:00',
      'projeto': 'P', 'Coordenador': 'X', 'Coord Acompanha': 'NÃO',
    });
    expect(validation.errors.some((e) => e.code === 'TIME_ORDER')).toBe(true);
  });

  it('warns when cancelar = SIM', () => {
    const { validation } = normalizeAgendaRow({
      'Municípios': 'X - BA', 'data': '01/01/2026', 'hora início': '07:00', 'hora fim': '17:00',
      'projeto': 'P', 'Coordenador': 'X', 'Cancelar': 'SIM',
    });
    expect(validation.status).toBe('warning');
    expect(validation.warnings.some((w) => w.code === 'EVENT_CANCELED')).toBe(true);
  });

  it('errors when coord_acompanha=SIM but no coordenador', () => {
    const { validation } = normalizeAgendaRow({
      'Municípios': 'X - BA', 'data': '01/01/2026', 'hora início': '07:00', 'hora fim': '17:00',
      'projeto': 'P', 'Coord Acompanha': 'SIM',
    });
    expect(validation.errors.some((e) => e.code === 'COORDINATOR_REQUIRED')).toBe(true);
  });
});
