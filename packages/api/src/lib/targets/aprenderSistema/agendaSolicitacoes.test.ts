import { describe, it, expect } from 'vitest';
import { buildAprenderSistemaTarget } from './index.js';
import { envelopeOf } from './test-helpers.js';

const baseEvento = {
  id: '42',
  titulo: 'Formação Exemplo',
  municipio: 'Cidade - BA',
  ef: '1',
  tipo: 'Presencial',
  data: '12/02/2026',
  inicio: '07:00',
  fim: '17:00',
  projeto: 'Tema',
  segmento: '1 e 2',
};

const baseAgendaLegacy = {
  'Municípios': 'Cidade - BA',
  data: '12/02/2026',
  'hora início': '07:00',
  'hora fim': '17:00',
  projeto: 'Tema',
  Coordenador: 'Coordenador Um',
  'Coord Acompanha': 'SIM',
  'Formador 1': 'Formador A',
  'Formador 2': 'Formador B',
};

describe('aprender_sistema target — agenda_solicitacoes (eventos)', () => {
  it('eventos → target agenda_solicitacoes', () => {
    const env = envelopeOf('Eventos', [baseEvento]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0];
    expect(r.target_type).toBe('agenda_solicitacoes');
    if (r.target_type !== 'agenda_solicitacoes') throw new Error('type narrow');
    expect(r).toMatchObject({
      municipio: 'Cidade',
      uf: 'BA',
      projeto: 'Tema',
      tipo_evento: 'Presencial',
      data: '2026-02-12',
      hora_inicio: '07:00:00',
      hora_fim: '17:00:00',
      coordenador: null,
      formador1: null,
      encontro: '1',
      segmento: '1 e 2',
    });
    // eventos has no Coordenador column — should always note the gap.
    expect(r.issues.find((i) => i.code === 'COORDINATOR_REVIEW_REQUIRED')).toBeTruthy();
  });

  it('convidados-by-name in eventos → FORMADOR_REVIEW_REQUIRED', () => {
    const env = envelopeOf('Eventos', [{ ...baseEvento, convidado1: 'Pessoa Nome' }]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0];
    expect(r.issues.find((i) => i.code === 'FORMADOR_REVIEW_REQUIRED')).toBeTruthy();
  });

  it('convidados-by-email in eventos → GUESTS_NOT_IMPORTED', () => {
    const env = envelopeOf('Eventos', [{ ...baseEvento, convidado1: 'a@example.com' }]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0];
    expect(r.issues.find((i) => i.code === 'GUESTS_NOT_IMPORTED')).toBeTruthy();
  });

  it('titulo=SIM (boolean leak) → review, not agenda', () => {
    const env = envelopeOf('Eventos', [{ ...baseEvento, titulo: 'SIM' }]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0];
    expect(r.target_type).toBe('review');
    if (r.target_type !== 'review') throw new Error('type narrow');
    expect(r.reason_codes).toContain('SUSPICIOUS_TITLE_BOOLEAN');
  });
});

describe('aprender_sistema target — agenda_solicitacoes (legacy agenda)', () => {
  it('agenda legacy → target with coordenador and formadores populated', () => {
    const env = envelopeOf('Agenda', [baseAgendaLegacy]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0];
    expect(r.target_type).toBe('agenda_solicitacoes');
    if (r.target_type !== 'agenda_solicitacoes') throw new Error('type narrow');
    expect(r.coordenador).toBe('Coordenador Um');
    expect(r.formador1).toBe('Formador A');
    expect(r.formador2).toBe('Formador B');
    expect(r.formador3).toBeNull();
  });
});
