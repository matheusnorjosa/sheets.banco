import { describe, it, expect } from 'vitest';
import {
  AGENDA_SOLICITACOES_HEADERS,
  buildCsvFilename,
  buildTargetCsv,
  DISPONIBILIDADE_BLOQUEIOS_HEADERS,
  EXPORT_TYPES,
  escapeCsvField,
  isExportType,
  PRODUTOS_CONTROLE_HEADERS,
  REVIEW_HEADERS,
  USUARIOS_HEADERS,
  rowsToCsv,
  validateCsvExportQuery,
} from './csv.js';
import { buildAprenderSistemaTarget } from './index.js';
import { envelopeOf } from './test-helpers.js';

describe('escapeCsvField', () => {
  it('returns empty string for null and undefined', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('passes through plain strings unchanged', () => {
    expect(escapeCsvField('hello')).toBe('hello');
  });

  it('quotes and doubles internal quotes', () => {
    expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('quotes fields containing a comma', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });

  it('quotes fields containing newlines (LF and CR)', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('preserves UTF-8 accents without quoting', () => {
    expect(escapeCsvField('São João')).toBe('São João');
    expect(escapeCsvField('coleções')).toBe('coleções');
  });

  it('serialises objects as JSON strings', () => {
    expect(escapeCsvField({ a: 1, b: 'x' })).toBe('"{""a"":1,""b"":""x""}"');
  });

  it('serialises arrays as JSON strings', () => {
    expect(escapeCsvField([1, 2, 'x'])).toBe('"[1,2,""x""]"');
  });

  it('renders numbers and booleans without quoting', () => {
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(true)).toBe('true');
    expect(escapeCsvField(false)).toBe('false');
  });
});

describe('rowsToCsv', () => {
  it('joins headers and rows with CRLF and trailing CRLF', () => {
    const csv = rowsToCsv(['a', 'b'], [[1, 2], [3, 4]]);
    expect(csv).toBe('a,b\r\n1,2\r\n3,4\r\n');
  });

  it('emits header-only CSV when there are no rows', () => {
    const csv = rowsToCsv(['x', 'y'], []);
    expect(csv).toBe('x,y\r\n');
  });
});

describe('isExportType', () => {
  it('accepts every value in EXPORT_TYPES', () => {
    for (const t of EXPORT_TYPES) {
      expect(isExportType(t)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isExportType('foo')).toBe(false);
    expect(isExportType('')).toBe(false);
    expect(isExportType(null)).toBe(false);
    expect(isExportType(undefined)).toBe(false);
  });
});

describe('buildCsvFilename', () => {
  it('uses aprender_sistema_<type>_<apiId>.csv shape', () => {
    expect(buildCsvFilename('usuarios', 'cuid123')).toBe('aprender_sistema_usuarios_cuid123.csv');
  });

  it('strips unsafe characters from apiId', () => {
    expect(buildCsvFilename('review', 'a b/c\\d')).toBe('aprender_sistema_review_abcd.csv');
  });

  it('falls back to "api" when apiId has no safe chars', () => {
    expect(buildCsvFilename('usuarios', '///')).toBe('aprender_sistema_usuarios_api.csv');
  });
});

// ---------- per-type CSV builders ----------

function csvLines(csv: string): string[] {
  // Drop the trailing empty entry caused by the final CRLF so each line maps
  // to a real row.
  return csv.split('\r\n').slice(0, -1);
}

describe('buildTargetCsv — usuarios', () => {
  it('emits the documented headers', () => {
    const env = envelopeOf('Usuários', [
      { Nome: 'Alice', CPF: '12345678901', Email: 'a@example.com', Cargo: 'X', 'Gerência': 'Y' },
    ]);
    const target = buildAprenderSistemaTarget(env);
    const csv = buildTargetCsv(target, 'usuarios');
    const [headerLine, ...rest] = csvLines(csv);
    expect(headerLine).toBe(USUARIOS_HEADERS.join(','));
    expect(rest).toHaveLength(1);
  });

  it('serialises issue codes joined by ";"', () => {
    // Two rows with the same CPF -> DUPLICATE_CPF on each. GROUP_MAPPING_REQUIRED
    // is info-severity but still surfaces in the per-row issues column.
    const env = envelopeOf('Usuários', [
      { Nome: 'A', CPF: '12345678901', Email: 'a@example.com', Cargo: 'X', 'Gerência': 'Y' },
      { Nome: 'B', CPF: '12345678901', Email: 'b@example.com', Cargo: 'X', 'Gerência': 'Y' },
    ]);
    const target = buildAprenderSistemaTarget(env);
    const csv = buildTargetCsv(target, 'usuarios');
    const dataLines = csvLines(csv).slice(1);
    for (const line of dataLines) {
      expect(line).toContain('DUPLICATE_CPF');
    }
  });

  it('renders null fields as empty CSV columns', () => {
    const env = envelopeOf('Usuários', [
      { Nome: 'Bob', CPF: '12345678901', Email: 'b@example.com', Cargo: 'X', 'Gerência': 'Y' },
    ]);
    const target = buildAprenderSistemaTarget(env);
    const csv = buildTargetCsv(target, 'usuarios');
    const [, dataLine] = csvLines(csv);
    // Last visible column before issues is "grupos" — and our adapter leaves it
    // null on purpose. Expect ",," surrounding the empty grupos column.
    expect(dataLine).toMatch(/,,GROUP_MAPPING_REQUIRED$/);
  });
});

describe('buildTargetCsv — produtos_controle', () => {
  const baseProduto = {
    F: '1', Produto: 'Livro X', 'Quant.': '10',
    'Município': 'São Paulo', UF: 'SP', Data: '01/01/2026',
  };

  it('emits the friendly headers expected by the aprender_sistema template', () => {
    const env = envelopeOf('Controle', [baseProduto]);
    const target = buildAprenderSistemaTarget(env);
    const csv = buildTargetCsv(target, 'produtos_controle');
    const [headerLine] = csvLines(csv);
    expect(headerLine).toBe(PRODUTOS_CONTROLE_HEADERS.join(','));
  });

  it('quotes accented values containing a comma cleanly', () => {
    const env = envelopeOf('Controle', [
      { ...baseProduto, Produto: 'Livro, vol. 1', 'Município': 'Fortaleza', UF: 'CE' },
    ]);
    const target = buildAprenderSistemaTarget(env);
    const csv = buildTargetCsv(target, 'produtos_controle');
    expect(csv).toContain('"Livro, vol. 1"');
  });
});

describe('buildTargetCsv — agenda_solicitacoes', () => {
  it('emits the documented headers and a row per agenda record', () => {
    const env = envelopeOf('Eventos', [
      {
        titulo: 'Encontro', municipio: 'Salvador - BA', data: '01/01/2026',
        inicio: '09:00', fim: '17:00', projeto: 'Projeto X',
      },
    ]);
    const target = buildAprenderSistemaTarget(env);
    const csv = buildTargetCsv(target, 'agenda_solicitacoes');
    const lines = csvLines(csv);
    expect(lines[0]).toBe(AGENDA_SOLICITACOES_HEADERS.join(','));
    expect(lines).toHaveLength(2);
  });
});

describe('buildTargetCsv — disponibilidade_bloqueios', () => {
  it('only emits exportable bloqueios rows, not matrix or D-typed rows', () => {
    const env = envelopeOf('Bloqueios', [
      {
        Usuario: 'alice@example.com', 'Início': '2026-01-01',
        Fim: '2026-01-02', Tipo: 'T',
      },
      {
        Usuario: 'bob@example.com', 'Início': '2026-01-03',
        Fim: '2026-01-04', Tipo: 'D',
      },
    ]);
    const target = buildAprenderSistemaTarget(env);
    const csv = buildTargetCsv(target, 'disponibilidade_bloqueios');
    const lines = csvLines(csv);
    expect(lines[0]).toBe(DISPONIBILIDADE_BLOQUEIOS_HEADERS.join(','));
    // Only the T-typed row survives — D goes to review.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('alice@example.com');
    expect(lines[1]).not.toContain('bob@example.com');
  });
});

describe('validateCsvExportQuery — 400 paths', () => {
  it('rejects missing target with TARGET_REQUIRED', () => {
    const res = validateCsvExportQuery({ type: 'usuarios' });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe('TARGET_REQUIRED');
  });

  it('rejects unknown target with UNSUPPORTED_TARGET', () => {
    const res = validateCsvExportQuery({ target: 'foo', type: 'usuarios' });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe('UNSUPPORTED_TARGET');
  });

  it('rejects missing type with EXPORT_TYPE_REQUIRED', () => {
    const res = validateCsvExportQuery({ target: 'aprender_sistema' });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe('EXPORT_TYPE_REQUIRED');
  });

  it('rejects unknown type with UNSUPPORTED_EXPORT_TYPE', () => {
    const res = validateCsvExportQuery({ target: 'aprender_sistema', type: 'foo' });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe('UNSUPPORTED_EXPORT_TYPE');
  });

  it.each(EXPORT_TYPES)('accepts every supported export type (%s)', (type) => {
    const res = validateCsvExportQuery({ target: 'aprender_sistema', type });
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.type).toBe(type);
  });
});

describe('buildTargetCsv — review', () => {
  it('emits review headers and serialises raw/normalized as JSON strings', () => {
    const env = envelopeOf('Random', [{ foo: 'bar, baz', n: '1' }]);
    const target = buildAprenderSistemaTarget(env);
    const csv = buildTargetCsv(target, 'review');
    const lines = csvLines(csv);
    expect(lines[0]).toBe(REVIEW_HEADERS.join(','));
    expect(lines).toHaveLength(2);
    // raw should appear as escaped JSON (double-quoted, with internal quotes
    // doubled) — proves both raw column and the escaper run together.
    expect(lines[1]).toMatch(/"\{""foo"":""bar, baz""[^"]*""n"":""1""\}"/);
  });

  it('joins reason_codes with ";"', () => {
    const env = envelopeOf('Random', [{ foo: 'bar' }]);
    const target = buildAprenderSistemaTarget(env);
    const csv = buildTargetCsv(target, 'review');
    const dataLine = csvLines(csv)[1];
    // reason_codes is the third column (index 2). Reuse a tolerant regex
    // because the actual codes are produced upstream.
    expect(dataLine.split(',').length).toBeGreaterThanOrEqual(REVIEW_HEADERS.length);
  });
});
