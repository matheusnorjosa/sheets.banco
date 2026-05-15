import { describe, it, expect } from 'vitest';
import { isSafeKey, createSafeRecord, DANGEROUS_KEYS } from './safe-keys.js';
import { processSpecialValues } from './special-values.js';
import { sanitizeRow } from './sanitize.js';

describe('safe-keys helpers', () => {
  it('isSafeKey blocks the documented dangerous names', () => {
    expect(isSafeKey('__proto__')).toBe(false);
    expect(isSafeKey('constructor')).toBe(false);
    expect(isSafeKey('prototype')).toBe(false);
  });

  it('isSafeKey accepts normal column names', () => {
    expect(isSafeKey('nome')).toBe(true);
    expect(isSafeKey('CPF')).toBe(true);
    expect(isSafeKey('')).toBe(true); // empty is unusual but not dangerous
    expect(isSafeKey('__Foo__')).toBe(true);
  });

  it('createSafeRecord has no prototype chain', () => {
    const r = createSafeRecord<string>();
    expect(Object.getPrototypeOf(r)).toBeNull();
    expect((r as any).toString).toBeUndefined();
  });

  it('DANGEROUS_KEYS does not leak past iteration', () => {
    // Smoke test: each entry should be a string
    for (const k of DANGEROUS_KEYS) {
      expect(typeof k).toBe('string');
    }
  });
});

describe('processSpecialValues — prototype pollution guard', () => {
  // JSON.parse('{"__proto__":...}') creates an object where __proto__ is an
  // own enumerable property — exactly what an attacker can send via JSON body.
  // The `{ __proto__: ... }` literal in source code is a different language
  // feature (assigns the prototype) and would not represent the threat model.

  it('drops __proto__ from result', () => {
    const malicious = JSON.parse('{"__proto__":"polluted","nome":"A"}') as Record<string, string>;
    const out = processSpecialValues(malicious);
    expect(out.nome).toBe('A');
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
  });

  it('does not pollute Object.prototype', () => {
    const malicious = JSON.parse('{"__proto__":"evil","constructor":"evil2"}') as Record<string, string>;
    processSpecialValues(malicious);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it('still processes normal TIMESTAMP / DATETIME values', () => {
    const out = processSpecialValues({ ts: 'TIMESTAMP', dt: 'DATETIME', name: 'A' });
    expect(out.name).toBe('A');
    expect(out.ts).toMatch(/^\d+$/);
    expect(out.dt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('sanitizeRow — prototype pollution guard', () => {
  it('drops dangerous keys', () => {
    const malicious = JSON.parse('{"__proto__":"x","constructor":"y","valid":"z"}') as Record<string, string>;
    const out = sanitizeRow(malicious);
    expect(out.valid).toBe('z');
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'constructor')).toBe(false);
  });

  it('still sanitizes formula-prefixed values', () => {
    const out = sanitizeRow({ formula: '=SUM(A1:A10)' });
    expect(out.formula).toBe("'=SUM(A1:A10)");
  });
});
