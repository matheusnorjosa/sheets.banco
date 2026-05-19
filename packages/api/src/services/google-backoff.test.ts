import { describe, it, expect, vi } from 'vitest';
import {
  computeDelay,
  isRetryable,
  parseRetryAfter,
  withBackoff,
} from './google-backoff.js';

// ────────────────────────────────────────────────────────────────────────────
// isRetryable
// ────────────────────────────────────────────────────────────────────────────

describe('isRetryable', () => {
  it('retries 429 / 408 / 500 / 502 / 503 / 504', () => {
    for (const code of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryable({ code, message: 'x' })).toBe(true);
    }
  });

  it('does NOT retry 400 / 401 / 404', () => {
    for (const code of [400, 401, 404]) {
      expect(isRetryable({ code, message: 'x' })).toBe(false);
    }
  });

  it('does NOT retry a vanilla 403 (real permission denied)', () => {
    expect(isRetryable({ code: 403, message: 'forbidden', errors: [{ reason: 'forbidden' }] })).toBe(false);
  });

  it('DOES retry 403 + reason=rateLimitExceeded', () => {
    expect(isRetryable({ code: 403, message: 'Rate Limit', errors: [{ reason: 'rateLimitExceeded' }] })).toBe(true);
  });

  it('DOES retry 403 + reason=userRateLimitExceeded', () => {
    expect(isRetryable({ code: 403, errors: [{ reason: 'userRateLimitExceeded' }] })).toBe(true);
  });

  it('DOES retry 403 + reason=quotaExceeded', () => {
    expect(isRetryable({ code: 403, errors: [{ reason: 'quotaExceeded' }] })).toBe(true);
  });

  it('DOES retry 403 + domain=usageLimits (legacy gspread fallback)', () => {
    expect(isRetryable({ code: 403, errors: [{ domain: 'usageLimits' }] })).toBe(true);
  });

  it('rejects non-objects gracefully', () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable('boom')).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false); // no `code`
    expect(isRetryable({})).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseRetryAfter
// ────────────────────────────────────────────────────────────────────────────

describe('parseRetryAfter', () => {
  it('returns null when no response/headers present', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter({ code: 429 })).toBeNull();
    expect(parseRetryAfter({ code: 429, response: {} })).toBeNull();
    expect(parseRetryAfter({ code: 429, response: { headers: {} } })).toBeNull();
  });

  it('parses seconds-as-integer (most common Google form)', () => {
    expect(parseRetryAfter({ code: 429, response: { headers: { 'retry-after': '5' } } })).toBe(5_000);
    expect(parseRetryAfter({ code: 429, response: { headers: { 'Retry-After': '0' } } })).toBe(0);
  });

  it('parses HTTP-date format', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const result = parseRetryAfter({ code: 429, response: { headers: { 'retry-after': future } } });
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(28_000);
    expect(result!).toBeLessThanOrEqual(31_000);
  });

  it('handles array-shaped header values (Node sometimes returns these)', () => {
    expect(parseRetryAfter({ code: 429, response: { headers: { 'retry-after': ['10'] } } })).toBe(10_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// computeDelay
// ────────────────────────────────────────────────────────────────────────────

describe('computeDelay', () => {
  it('honors Retry-After when present, capped at maxRetryAfterMs', () => {
    const err = { code: 429, response: { headers: { 'retry-after': '1000' } } }; // 1000s = way too long
    const d = computeDelay(err, 0, { maxRetryAfterMs: 60_000, baseMs: 1_000, maxBaseMs: 32_000 });
    expect(d).toBe(60_000);
  });

  it('falls back to capped exponential with full jitter when Retry-After absent', () => {
    const err = { code: 500 };
    // attempt 0 → exp = min(1000 * 1, 32000) = 1000 → delay in [0, 1000)
    const d0 = computeDelay(err, 0, { maxRetryAfterMs: 60_000, baseMs: 1_000, maxBaseMs: 32_000 });
    expect(d0).toBeGreaterThanOrEqual(0);
    expect(d0).toBeLessThan(1_000);
    // attempt 6 should hit the cap
    const d6 = computeDelay(err, 6, { maxRetryAfterMs: 60_000, baseMs: 1_000, maxBaseMs: 32_000 });
    expect(d6).toBeGreaterThanOrEqual(0);
    expect(d6).toBeLessThan(32_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// withBackoff
// ────────────────────────────────────────────────────────────────────────────

describe('withBackoff', () => {
  const noSleep = (_ms: number) => Promise.resolve();

  it('returns the value on a successful first attempt', async () => {
    const fn = vi.fn(async () => 'ok');
    const out = await withBackoff(fn, { sleep: noSleep });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and recovers on the second attempt', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('rate'), { code: 429 });
      return 'ok';
    });
    const out = await withBackoff(fn, { sleep: noSleep, baseMs: 0, maxBaseMs: 0 });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts on persistent 429', async () => {
    const err = Object.assign(new Error('rate'), { code: 429 });
    const fn = vi.fn(async () => { throw err; });
    await expect(withBackoff(fn, { sleep: noSleep, baseMs: 0, maxBaseMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a real 403 (permission denied)', async () => {
    const err = Object.assign(new Error('forbidden'), { code: 403, errors: [{ reason: 'forbidden' }] });
    const fn = vi.fn(async () => { throw err; });
    await expect(withBackoff(fn, { sleep: noSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 400 (e.g., malformed range slipping past sanitizer)', async () => {
    const err = Object.assign(new Error('Unable to parse range'), { code: 400 });
    const fn = vi.fn(async () => { throw err; });
    await expect(withBackoff(fn, { sleep: noSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After by passing the right delay to sleep (capped)', async () => {
    const err = Object.assign(new Error('rate'), {
      code: 429,
      response: { headers: { 'retry-after': '120' } },
    });
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw err;
      return 'ok';
    });
    const sleeps: number[] = [];
    const recordingSleep = async (ms: number) => { sleeps.push(ms); };
    await withBackoff(fn, { sleep: recordingSleep, maxRetryAfterMs: 60_000 });
    expect(sleeps).toEqual([60_000]); // 120s capped to 60s
  });

  it('respects a custom number of attempts', async () => {
    const err = Object.assign(new Error('500'), { code: 500 });
    const fn = vi.fn(async () => { throw err; });
    await expect(withBackoff(fn, { sleep: noSleep, attempts: 5, baseMs: 0, maxBaseMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
