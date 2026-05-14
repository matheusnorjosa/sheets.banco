import { describe, it, expect } from 'vitest';
import { cleanCpf, isCpfShapeValid } from './cpf.js';

describe('cleanCpf', () => {
  it('strips non-digits', () => {
    expect(cleanCpf('410.022.453-20')).toBe('41002245320');
    expect(cleanCpf('41002245320')).toBe('41002245320');
    expect(cleanCpf('  410 022 453 20 ')).toBe('41002245320');
  });

  it('handles nullish', () => {
    expect(cleanCpf(null)).toBe('');
    expect(cleanCpf(undefined)).toBe('');
  });
});

describe('isCpfShapeValid', () => {
  it('passes 11 digits', () => {
    expect(isCpfShapeValid('41002245320')).toBe(true);
  });
  it('fails other lengths', () => {
    expect(isCpfShapeValid('1234')).toBe(false);
    expect(isCpfShapeValid('123456789012')).toBe(false);
  });
});
