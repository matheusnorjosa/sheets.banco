import { describe, it, expect } from 'vitest';
import { detectType } from './index.js';

describe('detectType', () => {
  it('detects users', () => {
    expect(detectType(['Nome', 'Nome Completo', 'CPF', 'Telefone', 'Email', 'Cargo', 'Gerência'])).toBe('users');
  });

  it('detects produtos', () => {
    expect(detectType(['F', 'Produto', 'Quant.', 'Município', 'UF', 'Data', 'Uso das coleções'])).toBe('produtos');
  });

  it('detects agenda (spec original com Coordenador)', () => {
    expect(detectType(['Municípios', 'data', 'hora início', 'hora fim', 'projeto', 'Coordenador'])).toBe('agenda');
  });

  it('detects eventos (real schema sem Coordenador)', () => {
    expect(
      detectType([
        'id', 'titulo', 'municipio', 'ef', 'tipo', 'data', 'inicio', 'fim',
        'projeto', 'segmento', 'convidado1', 'convidado2', 'convidado3',
      ]),
    ).toBe('eventos');
  });

  it('detects eventos sem convidados', () => {
    expect(detectType(['titulo', 'municipio', 'data', 'inicio', 'fim', 'projeto'])).toBe('eventos');
  });

  it('detects bloqueios', () => {
    expect(detectType(['Usuário', 'Inicio', 'Fim', 'Tipo'])).toBe('bloqueios');
    expect(detectType(['Usuario', 'Início', 'Fim', 'Tipo'])).toBe('bloqueios');
  });

  it('detects deslocamento (>=2 Pessoa N cols)', () => {
    expect(detectType(['Município', 'Tipo', 'Destino', 'Data', 'Pessoa 1', 'Pessoa 2'])).toBe('deslocamento');
    expect(detectType(['Pessoa 1', 'Pessoa 2', 'Pessoa 3', 'Pessoa 4', 'Pessoa 5', 'Pessoa 6'])).toBe('deslocamento');
  });

  it('detects disponibilidade_anual (month-name headers)', () => {
    expect(
      detectType([
        'FORMADOR', 'JAN.', 'FEV.', 'MAR.', 'ABR.', 'MAI.', 'JUN.',
        'JUL.', 'AGO.', 'SET.', 'OUT.', 'NOV.', 'DEZ.',
      ]),
    ).toBe('disponibilidade_anual');
  });

  it('detects disponibilidade_mensal (numeric day headers 1-31)', () => {
    const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
    expect(detectType(['Formador', ...days])).toBe('disponibilidade_mensal');
  });

  it('detects mensal even when the user column is unconventional', () => {
    const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
    expect(detectType(['MAI.', ...days])).toBe('disponibilidade_mensal');
  });

  it('returns unknown for unrecognized headers', () => {
    expect(detectType(['foo', 'bar', 'baz'])).toBe('unknown');
    expect(detectType([])).toBe('unknown');
    expect(detectType(['Formador', '1', '2'])).toBe('unknown'); // too few day cols
  });

  it('is accent- and case-insensitive', () => {
    expect(detectType(['nome', 'CPF', 'cargo', 'email'])).toBe('users');
  });
});
