import { describe, it, expect } from 'vitest';
import { buildAprenderSistemaTarget } from './index.js';
import { envelopeOf } from './test-helpers.js';

const baseProduto = {
  F: '410',
  Produto: 'PRODUTO EXEMPLO',
  'Quant.': '185',
  'Município': 'Cidade Teste',
  UF: 'MG',
  Data: '13/11/2023',
  'Uso das coleções': 'SIM',
};

describe('aprender_sistema target — produtos_controle', () => {
  it('produtos → target produtos_controle', () => {
    const env = envelopeOf('Controle', [baseProduto]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0]!;
    expect(r.target_type).toBe('produtos_controle');
    if (r.target_type !== 'produtos_controle') throw new Error('type narrow');
    expect(r).toMatchObject({
      codigo: '410',
      produto: 'PRODUTO EXEMPLO',
      quantidade: 185,
      municipio: 'Cidade Teste',
      uf: 'MG',
      data: '2023-11-13',
      uso_das_colecoes: 'SIM',
    });
  });

  it('always attaches PRODUCT_REVIEW_RECOMMENDED (no catalog yet)', () => {
    const env = envelopeOf('Controle', [baseProduto]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0]!;
    expect(r.issues.find((i) => i.code === 'PRODUCT_REVIEW_RECOMMENDED')).toBeTruthy();
  });

  it('invalid produto row (no produto) → review', () => {
    const env = envelopeOf('Controle', [{ ...baseProduto, Produto: '' }]);
    const t = buildAprenderSistemaTarget(env);
    expect(t.records[0]!.target_type).toBe('review');
  });

  it('uso_das_colecoes false → "NAO"', () => {
    const env = envelopeOf('Controle', [{ ...baseProduto, 'Uso das coleções': 'NÃO' }]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0]!;
    if (r.target_type !== 'produtos_controle') throw new Error('type narrow');
    expect(r.uso_das_colecoes).toBe('NAO');
  });

  // End-to-end coverage for the Controle 🟥 COMPRAS shape (id column instead
  // of F). Proves detection + normalizer + target adapter all carry the id
  // through to target.codigo so the produtos_controle CSV ends up with CÓD
  // filled in for that sheet.
  it('detects and adapts Controle 🟥 COMPRAS shape (id-based)', () => {
    const comprasRow = {
      id: 'C-001',
      Produto: 'PRODUTO COMPRAS',
      'Quant.': '5',
      'Município': 'Recife',
      UF: 'PE',
      Data: '15/03/2026',
      'Uso das coleções': 'SIM',
    };
    const env = envelopeOf('🟥 COMPRAS', [comprasRow]);
    const t = buildAprenderSistemaTarget(env);
    const r = t.records[0]!;
    expect(r.target_type).toBe('produtos_controle');
    if (r.target_type !== 'produtos_controle') throw new Error('type narrow');
    expect(r.codigo).toBe('C-001');
    expect(r.produto).toBe('PRODUTO COMPRAS');
    expect(r.quantidade).toBe(5);
  });
});
