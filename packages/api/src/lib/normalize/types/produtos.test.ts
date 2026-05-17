import { describe, it, expect } from 'vitest';
import { normalizeProdutoRow } from './produtos.js';

describe('normalizeProdutoRow', () => {
  it('normalizes typical row', () => {
    const { normalized, validation } = normalizeProdutoRow({
      F: '410',
      Produto: 'FLUIR DAS EMOÇÕES - O CÉREBRO E AS EMOÇÕES.',
      'Quant.': '185',
      'Município': 'FELIXLANDIA',
      UF: 'MG',
      Data: '13/11/2023',
      'Uso das coleções': 'SIM',
    });
    expect(normalized).toMatchObject({
      codigo_original: '410',
      produto_original: 'FLUIR DAS EMOÇÕES - O CÉREBRO E AS EMOÇÕES.',
      produto_key: 'FLUIR DAS EMOCOES - O CEREBRO E AS EMOCOES',
      quantidade: 185,
      municipio_original: 'FELIXLANDIA',
      municipio_key: 'FELIXLANDIA_MG',
      uf: 'MG',
      data: '2023-11-13',
      uso_colecao_2026: true,
    });
    expect(validation.status).toBe('valid');
  });

  it('errors on missing produto', () => {
    const { validation } = normalizeProdutoRow({ F: '1', 'Quant.': '5', 'Município': 'X', UF: 'BA', Data: '01/01/2024' });
    expect(validation.errors.some((e) => e.code === 'PRODUCT_REQUIRED')).toBe(true);
  });

  it('errors on non-numeric quantidade', () => {
    const { validation } = normalizeProdutoRow({
      F: '1', Produto: 'X', 'Quant.': 'abc', 'Município': 'Y', UF: 'BA', Data: '01/01/2024',
    });
    expect(validation.errors.some((e) => e.code === 'QUANTITY_INVALID')).toBe(true);
  });

  it('errors on invalid date', () => {
    const { validation } = normalizeProdutoRow({
      F: '1', Produto: 'X', 'Quant.': '1', 'Município': 'Y', UF: 'BA', Data: '30/02/2024',
    });
    expect(validation.errors.some((e) => e.code === 'DATE_INVALID')).toBe(true);
  });

  it('handles Brazilian thousand-dot quantities', () => {
    const { normalized } = normalizeProdutoRow({
      F: '1', Produto: 'X', 'Quant.': '1.234', 'Município': 'Y', UF: 'BA', Data: '01/01/2024',
    });
    expect(normalized.quantidade).toBe(1234);
  });

  it('accepts "id" header as the código identifier (Controle 🟥 COMPRAS)', () => {
    const { normalized, validation } = normalizeProdutoRow({
      id: 'X-001',
      Produto: 'PRODUTO TESTE',
      'Quant.': '10',
      'Município': 'Fortaleza',
      UF: 'CE',
      Data: '01/01/2026',
    });
    expect(normalized.codigo_original).toBe('X-001');
    expect(validation.status).toBe('valid');
  });
});
