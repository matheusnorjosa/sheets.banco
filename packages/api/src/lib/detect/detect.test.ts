import { describe, it, expect } from 'vitest';
import { detectType } from './index.js';

describe('detectType', () => {
  it('detects users', () => {
    expect(detectType(['Nome', 'Nome Completo', 'CPF', 'Telefone', 'Email', 'Cargo', 'Gerência'])).toBe('users');
  });

  it('detects produtos', () => {
    expect(detectType(['F', 'Produto', 'Quant.', 'Município', 'UF', 'Data', 'Uso das coleções'])).toBe('produtos');
    expect(detectType(['F', 'Produto', 'Quantidade', 'Município', 'UF', 'Data'])).toBe('produtos');
  });

  it('detects agenda', () => {
    expect(detectType(['Municípios', 'data', 'hora início', 'hora fim', 'projeto', 'Coordenador'])).toBe('agenda');
    expect(detectType(['Aprovação', 'Atualizar', 'Cancelar', 'Municípios', 'encontro', 'tipo', 'data', 'hora início', 'hora fim', 'projeto', 'segmento', 'Coord Acompanha', 'Coordenador', 'Formador 1'])).toBe('agenda');
  });

  it('returns unknown for unrecognized headers', () => {
    expect(detectType(['', '', '', 'EM MANUTENÇÃO'])).toBe('unknown');
    expect(detectType(['JUL.', '1', '2', '3'])).toBe('unknown');
    expect(detectType([])).toBe('unknown');
  });

  it('is accent- and case-insensitive', () => {
    expect(detectType(['nome', 'CPF', 'cargo', 'email'])).toBe('users');
  });
});
