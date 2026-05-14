import { describe, it, expect } from 'vitest';
import { normalizeEventoRow } from './eventos.js';

describe('normalizeEventoRow', () => {
  it('normalizes typical row', () => {
    const { normalized, validation } = normalizeEventoRow({
      id: '42',
      titulo: 'Formação Exemplo',
      municipio: 'CIDADE FICTÍCIA - BA',
      ef: '1',
      tipo: 'Presencial',
      data: '12/02/2026',
      inicio: '07:00',
      fim: '17:00',
      projeto: 'Tema',
      segmento: '1 e 2',
      convidado1: 'fulano@example.com',
      convidado2: 'beltrana@example.com',
      convidado3: '',
    });

    expect(normalized).toMatchObject({
      external_id: '42',
      titulo: 'Formação Exemplo',
      titulo_key: 'FORMACAO EXEMPLO',
      municipio_original: 'CIDADE FICTÍCIA - BA',
      municipio: 'CIDADE FICTÍCIA',
      uf: 'BA',
      municipio_key: 'CIDADE_FICTICIA_BA',
      ef: '1',
      tipo_original: 'Presencial',
      tipo_key: 'PRESENCIAL',
      data: '2026-02-12',
      hora_inicio: '07:00:00',
      hora_fim: '17:00:00',
      inicio_iso: '2026-02-12T07:00:00-03:00',
      fim_iso: '2026-02-12T17:00:00-03:00',
      projeto_original: 'Tema',
      projeto_key: 'TEMA',
      segmento: '1 e 2',
      convidados: ['fulano@example.com', 'beltrana@example.com'],
    });
    expect(validation.status).toBe('valid');
  });

  it('warns on non-email convidados and drops them from the array', () => {
    const { normalized, validation } = normalizeEventoRow({
      titulo: 'Foo',
      municipio: 'X - BA',
      data: '01/01/2026',
      inicio: '07:00',
      fim: '17:00',
      projeto: 'P',
      convidado1: 'Nome Pessoa',
    });

    expect(normalized.convidados).toEqual([]);
    expect(validation.status).toBe('warning');
    expect(validation.warnings.some((w) => w.code === 'GUEST_NOT_EMAIL')).toBe(true);
  });

  it('errors when fim <= inicio', () => {
    const { validation } = normalizeEventoRow({
      titulo: 'Foo',
      municipio: 'X - BA',
      data: '01/01/2026',
      inicio: '10:00',
      fim: '09:00',
      projeto: 'P',
    });
    expect(validation.errors.some((e) => e.code === 'TIME_ORDER')).toBe(true);
  });

  it('errors when titulo / projeto missing', () => {
    const { validation } = normalizeEventoRow({
      titulo: '',
      municipio: 'X - BA',
      data: '01/01/2026',
      inicio: '07:00',
      fim: '17:00',
      projeto: '',
    });
    expect(validation.errors.some((e) => e.code === 'TITLE_REQUIRED')).toBe(true);
    expect(validation.errors.some((e) => e.code === 'PROJECT_REQUIRED')).toBe(true);
  });
});
