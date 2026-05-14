import { describe, it, expect } from 'vitest';
import { normalizeEmail, isEmailValid, splitEmails } from './email.js';

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@Bar.Com  ')).toBe('foo@bar.com');
  });
});

describe('isEmailValid', () => {
  it('accepts well-formed', () => {
    expect(isEmailValid('foo@bar.com')).toBe(true);
  });
  it('rejects malformed', () => {
    expect(isEmailValid('foo@bar')).toBe(false);
    expect(isEmailValid('foo')).toBe(false);
    expect(isEmailValid('@bar.com')).toBe(false);
  });
});

describe('splitEmails', () => {
  it('splits on comma/semicolon and dedups', () => {
    expect(splitEmails('a@b.com, A@B.COM ;c@d.com')).toEqual(['a@b.com', 'c@d.com']);
  });
  it('drops invalid entries', () => {
    expect(splitEmails('a@b.com, garbage, c@d.com')).toEqual(['a@b.com', 'c@d.com']);
  });
});
