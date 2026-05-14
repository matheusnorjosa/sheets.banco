import { describe, it, expect } from 'vitest';
import { extractPeriodFromSheetName } from './period.js';

describe('extractPeriodFromSheetName', () => {
  it('extracts year', () => {
    expect(extractPeriodFromSheetName('ANUAL 2026')).toEqual({ mes: null, ano: 2026 });
  });

  it('extracts month abbreviations', () => {
    expect(extractPeriodFromSheetName('Disponibilidade MAI 2026')).toEqual({ mes: 5, ano: 2026 });
    expect(extractPeriodFromSheetName('MENSAL FEV. 2025')).toEqual({ mes: 2, ano: 2025 });
  });

  it('returns nulls when nothing is extractable', () => {
    expect(extractPeriodFromSheetName('MENSAL')).toEqual({ mes: null, ano: null });
    expect(extractPeriodFromSheetName('Configurações')).toEqual({ mes: null, ano: null });
  });
});
