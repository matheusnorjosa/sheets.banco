/**
 * Object keys that, when assigned to a plain object, can modify
 * `Object.prototype` (or otherwise escape the intended record). These come
 * from user-controlled spreadsheet rows, so we must never write to them.
 *
 * Use `isSafeKey()` together with `createSafeRecord()` to guard both the
 * write path (skip dangerous keys) and the storage prototype (no proto chain
 * to pollute).
 */
export const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

export function isSafeKey(key: string): boolean {
  return !DANGEROUS_KEYS.has(key);
}

/**
 * Like `{}` but with a null prototype — assigning to a dangerous key on the
 * resulting object just creates a property, never traverses Object.prototype.
 */
export function createSafeRecord<V = string>(): Record<string, V> {
  return Object.create(null) as Record<string, V>;
}
