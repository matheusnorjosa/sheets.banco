import { describe, it, expect } from 'vitest';
import { normalizeEventoRow } from './eventos.js';

describe('normalizeEventoRow — base flow', () => {
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
      convidados_emails: ['fulano@example.com', 'beltrana@example.com'],
      convidados_nomes: [],
      convidados_invalidos: [],
      flags: {},
    });
    expect(validation.status).toBe('valid');
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

describe('normalizeEventoRow — convidados split', () => {
  const base = {
    titulo: 'Foo',
    municipio: 'X - BA',
    data: '01/01/2026',
    inicio: '07:00',
    fim: '17:00',
    projeto: 'P',
  };

  it('routes valid emails to convidados_emails', () => {
    const { normalized } = normalizeEventoRow({
      ...base,
      convidado1: 'a@example.com',
      convidado2: 'b@example.com',
    });
    expect(normalized.convidados_emails).toEqual(['a@example.com', 'b@example.com']);
    expect(normalized.convidados_nomes).toEqual([]);
    expect(normalized.convidados_invalidos).toEqual([]);
  });

  it('routes plain names to convidados_nomes with GUEST_NOT_EMAIL warning', () => {
    const { normalized, validation } = normalizeEventoRow({
      ...base,
      convidado1: 'Pessoa Exemplo',
    });
    expect(normalized.convidados_nomes).toEqual(['Pessoa Exemplo']);
    expect(normalized.convidados_emails).toEqual([]);
    expect(normalized.convidados_invalidos).toEqual([]);
    expect(validation.warnings.some((w) => w.code === 'GUEST_NOT_EMAIL')).toBe(true);
  });

  it('ignores empty convidados', () => {
    const { normalized, validation } = normalizeEventoRow({
      ...base,
      convidado1: '',
      convidado2: '   ',
    });
    expect(normalized.convidados_emails).toEqual([]);
    expect(normalized.convidados_nomes).toEqual([]);
    expect(normalized.convidados_invalidos).toEqual([]);
    expect(validation.warnings.some((w) => w.code === 'GUEST_NOT_EMAIL')).toBe(false);
  });

  it('routes malformed-email-looking values to convidados_invalidos', () => {
    const { normalized, validation } = normalizeEventoRow({
      ...base,
      convidado1: 'foo@',           // has @ but malformed
      convidado2: 'broken@email',   // has @ but no TLD
    });
    expect(normalized.convidados_invalidos).toEqual(['foo@', 'broken@email']);
    expect(normalized.convidados_emails).toEqual([]);
    expect(normalized.convidados_nomes).toEqual([]);
    expect(validation.warnings.filter((w) => w.code === 'GUEST_INVALID_VALUE')).toHaveLength(2);
  });

  it('mixes all three buckets when needed', () => {
    const { normalized } = normalizeEventoRow({
      ...base,
      convidado1: 'real@example.com',
      convidado2: 'Pessoa Y',
      convidado3: '@@@',
    });
    expect(normalized.convidados_emails).toEqual(['real@example.com']);
    expect(normalized.convidados_nomes).toEqual(['Pessoa Y']);
    expect(normalized.convidados_invalidos).toEqual(['@@@']);
  });
});

describe('normalizeEventoRow — SIM/NÃO heuristic on id and titulo', () => {
  const base = {
    municipio: 'X - BA',
    data: '01/01/2026',
    inicio: '07:00',
    fim: '17:00',
    projeto: 'P',
  };

  it('id="SIM" → external_id null + flags.id_boolean=true + warning', () => {
    const { normalized, validation } = normalizeEventoRow({
      ...base, id: 'SIM', titulo: 'Real titulo',
    });
    expect(normalized.external_id).toBeNull();
    expect(normalized.flags.id_boolean).toBe(true);
    expect(validation.warnings.some((w) => w.code === 'SUSPICIOUS_ID_BOOLEAN')).toBe(true);
  });

  it('id="NÃO" → flags.id_boolean=false', () => {
    const { normalized } = normalizeEventoRow({
      ...base, id: 'NÃO', titulo: 'Real titulo',
    });
    expect(normalized.external_id).toBeNull();
    expect(normalized.flags.id_boolean).toBe(false);
  });

  it('titulo="SIM" → titulo and titulo_key null + flags.titulo_boolean + warning', () => {
    const { normalized, validation } = normalizeEventoRow({
      ...base, id: '42', titulo: 'SIM',
    });
    expect(normalized.titulo).toBeNull();
    expect(normalized.titulo_key).toBeNull();
    expect(normalized.flags.titulo_boolean).toBe(true);
    expect(validation.warnings.some((w) => w.code === 'SUSPICIOUS_TITLE_BOOLEAN')).toBe(true);
    // TITLE_REQUIRED should NOT also fire — the warning already conveys the issue.
    expect(validation.errors.some((e) => e.code === 'TITLE_REQUIRED')).toBe(false);
  });

  it('does not flag normal id/titulo values', () => {
    const { normalized, validation } = normalizeEventoRow({
      ...base, id: '42', titulo: 'Formação Real',
    });
    expect(normalized.external_id).toBe('42');
    expect(normalized.titulo).toBe('Formação Real');
    expect(normalized.flags).toEqual({});
    expect(validation.warnings.some((w) => w.code === 'SUSPICIOUS_ID_BOOLEAN')).toBe(false);
    expect(validation.warnings.some((w) => w.code === 'SUSPICIOUS_TITLE_BOOLEAN')).toBe(false);
  });

  it('handles all recognized boolean tokens', () => {
    for (const tok of ['SIM', 'NÃO', 'NAO', 'TRUE', 'FALSE', '1', '0']) {
      const { normalized } = normalizeEventoRow({ ...base, id: tok, titulo: 'X' });
      expect(normalized.external_id).toBeNull();
      expect(typeof normalized.flags.id_boolean).toBe('boolean');
    }
  });
});
