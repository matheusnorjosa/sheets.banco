/**
 * Tests for the per-sheet workbook snapshot builder + validator.
 * All fixtures are synthetic — no real product names, municipios, or PII.
 */
import { describe, it, expect } from 'vitest';
import {
  buildValueKeys,
  buildWorkbookSheetSnapshot,
  parseRangeStartRow,
  validateWorkbookQuery,
} from './snapshot.js';

describe('parseRangeStartRow', () => {
  it('returns 1 for undefined/empty range', () => {
    expect(parseRangeStartRow(undefined)).toBe(1);
    expect(parseRangeStartRow('')).toBe(1);
  });

  it('extracts the first row number from an A1 range', () => {
    expect(parseRangeStartRow('A1:Z100')).toBe(1);
    expect(parseRangeStartRow('A5:Z100')).toBe(5);
    expect(parseRangeStartRow('A50')).toBe(50);
    expect(parseRangeStartRow('5:10')).toBe(5);
  });

  it('defaults to 1 when the range has no row number (column-only)', () => {
    expect(parseRangeStartRow('A:A')).toBe(1);
    expect(parseRangeStartRow('B:Z')).toBe(1);
  });
});

describe('buildValueKeys', () => {
  it('preserves unique non-empty headers verbatim', () => {
    expect(buildValueKeys(['CPF', 'Nome', 'Cargo'])).toEqual(['CPF', 'Nome', 'Cargo']);
  });

  it('replaces empty/blank headers with __col_<1-based-index>', () => {
    expect(buildValueKeys(['A', '', ' ', 'B'])).toEqual(['A', '__col_2', '__col_3', 'B']);
  });

  it('suffixes duplicates with __2, __3, … (first occurrence keeps original)', () => {
    expect(buildValueKeys(['Produto', 'Produto', 'Produto'])).toEqual([
      'Produto', 'Produto__2', 'Produto__3',
    ]);
  });

  it('mixes empties and duplicates safely', () => {
    expect(buildValueKeys(['', 'Header', 'Header', '', 'Header'])).toEqual([
      '__col_1', 'Header', 'Header__2', '__col_4', 'Header__3',
    ]);
  });
});

describe('buildWorkbookSheetSnapshot', () => {
  it('exports a typical known-type sheet with headers + 2 data rows', () => {
    const snap = buildWorkbookSheetSnapshot({
      sheet_index: 0,
      sheet_name: 'Usuários',
      values: [
        ['Nome', 'CPF', 'Email', 'Cargo'],
        ['ALICE TEST', '11122233344', 'a@example.com', 'X'],
        ['BOB TEST',   '22233344455', 'b@example.com', 'Y'],
      ],
    });
    expect(snap.sheet_index).toBe(0);
    expect(snap.sheet_name).toBe('Usuários');
    expect(snap.detected_type).toBe('users');
    expect(snap.headers).toEqual(['Nome', 'CPF', 'Email', 'Cargo']);
    expect(snap.row_count).toBe(2);
    expect(snap.rows[0]).toEqual({
      row_number: 2,
      values: { Nome: 'ALICE TEST', CPF: '11122233344', Email: 'a@example.com', Cargo: 'X' },
      raw: ['ALICE TEST', '11122233344', 'a@example.com', 'X'],
    });
    expect(snap.rows[1].row_number).toBe(3);
  });

  it('handles unknown sheets without filtering them out', () => {
    const snap = buildWorkbookSheetSnapshot({
      sheet_index: 4,
      sheet_name: '☑️ TEST UNKNOWN TAB',
      values: [
        ['ColA', 'ColB'],
        ['v1', 'v2'],
      ],
    });
    expect(snap.detected_type).toBe('unknown');
    expect(snap.sheet_index).toBe(4);
    expect(snap.sheet_name).toBe('☑️ TEST UNKNOWN TAB');
    expect(snap.row_count).toBe(1);
    expect(snap.rows[0].values).toEqual({ ColA: 'v1', ColB: 'v2' });
  });

  it('preserves the original headers array even when value-keys diverge', () => {
    const snap = buildWorkbookSheetSnapshot({
      sheet_index: 0,
      sheet_name: 'Dups',
      values: [
        ['Produto', 'Produto', ''],
        ['p1',       'p2',       'p3'],
      ],
    });
    // Original headers stay verbatim.
    expect(snap.headers).toEqual(['Produto', 'Produto', '']);
    // values dict gets stable safe keys.
    expect(snap.rows[0].values).toEqual({
      Produto: 'p1',
      Produto__2: 'p2',
      __col_3: 'p3',
    });
    // raw preserves position.
    expect(snap.rows[0].raw).toEqual(['p1', 'p2', 'p3']);
  });

  it('discards rows where every cell is empty but keeps row_number contiguous to the source', () => {
    const snap = buildWorkbookSheetSnapshot({
      sheet_index: 0,
      sheet_name: 'WithGap',
      values: [
        ['A', 'B'],
        ['v1', 'v2'],   // sheet row 2
        ['',   ''],      // sheet row 3 — empty, dropped
        ['v3', 'v4'],   // sheet row 4
      ],
    });
    expect(snap.row_count).toBe(2);
    expect(snap.rows[0].row_number).toBe(2);
    expect(snap.rows[1].row_number).toBe(4); // jumps past the empty row
  });

  it('anchors row_number using the ?range= start when provided', () => {
    const snap = buildWorkbookSheetSnapshot({
      sheet_index: 0,
      sheet_name: 'Sliced',
      values: [
        ['H1', 'H2'],   // sheet row 5 — interpreted as headers
        ['v1', 'v2'],   // sheet row 6
        ['v3', 'v4'],   // sheet row 7
      ],
      range: 'A5:Z7',
    });
    expect(snap.rows[0].row_number).toBe(6);
    expect(snap.rows[1].row_number).toBe(7);
  });

  it('returns a coherent empty snapshot when values is [] (e.g., OOB range)', () => {
    const snap = buildWorkbookSheetSnapshot({
      sheet_index: 2,
      sheet_name: 'Empty',
      values: [],
      range: 'A999999:Z999999',
    });
    expect(snap.detected_type).toBe('unknown');
    expect(snap.headers).toEqual([]);
    expect(snap.row_count).toBe(0);
    expect(snap.rows).toEqual([]);
    expect(snap.sheet_index).toBe(2);
    expect(snap.sheet_name).toBe('Empty');
  });

  it('handles a sheet with header-only data (no rows)', () => {
    const snap = buildWorkbookSheetSnapshot({
      sheet_index: 0,
      sheet_name: 'HeaderOnly',
      values: [['Col1', 'Col2']],
    });
    expect(snap.headers).toEqual(['Col1', 'Col2']);
    expect(snap.row_count).toBe(0);
    expect(snap.rows).toEqual([]);
  });

  it('coerces missing trailing cells to empty strings (matches getRawValues output)', () => {
    const snap = buildWorkbookSheetSnapshot({
      sheet_index: 0,
      sheet_name: 'Short',
      values: [
        ['A', 'B', 'C'],
        ['v1'],           // shorter than header row
      ],
    });
    expect(snap.rows[0].raw).toEqual(['v1', '', '']);
    expect(snap.rows[0].values).toEqual({ A: 'v1', B: '', C: '' });
  });
});

describe('validateWorkbookQuery', () => {
  it('rejects missing sheet with WORKBOOK_SHEET_REQUIRED', () => {
    const res = validateWorkbookQuery({});
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe('WORKBOOK_SHEET_REQUIRED');
  });

  it('accepts a bare sheet name (no range)', () => {
    const res = validateWorkbookQuery({ sheet: 'Test' });
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.sheet).toBe('Test');
    expect(res.ok === true && res.range).toBeUndefined();
  });

  it('accepts a valid range alongside sheet', () => {
    const res = validateWorkbookQuery({ sheet: 'Test', range: 'A1:Z100' });
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.range).toBe('A1:Z100');
  });

  it('rejects a malformed range with VALIDATION_ERROR (does NOT mask as empty)', () => {
    const res = validateWorkbookQuery({ sheet: 'Test', range: 'NOT_A1' });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe('VALIDATION_ERROR');
  });
});
