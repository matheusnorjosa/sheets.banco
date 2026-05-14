import { uppercaseKey } from './text.js';

export type RawRow = Record<string, string>;

/**
 * Case- and accent-insensitive accessor for spreadsheet rows.
 * Looks up a value by trying each candidate header name (in order) and
 * returns the first non-empty match.
 */
export class RowAccessor {
  private map = new Map<string, string>();

  constructor(row: RawRow) {
    for (const [k, v] of Object.entries(row)) {
      this.map.set(uppercaseKey(k), String(v ?? ''));
    }
  }

  /** Get the first non-empty value matching any of the given names. */
  get(...names: string[]): string {
    for (const n of names) {
      const v = this.map.get(uppercaseKey(n));
      if (v !== undefined && v !== '') return v;
    }
    return '';
  }

  /** Get raw value for a single header (case/accent-insensitive), even if empty. */
  raw(name: string): string {
    return this.map.get(uppercaseKey(name)) ?? '';
  }

  /** True if the row has a value (non-empty) for any of the given names. */
  has(...names: string[]): boolean {
    return this.get(...names) !== '';
  }
}
