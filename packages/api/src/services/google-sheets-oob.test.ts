/**
 * Targeted tests for the out-of-bounds range fix on Google Sheets reads.
 *
 * Scope:
 *   - predicate isRangeOutOfBoundsError (pure)
 *   - getRawValues integration: OOB → [], auth/other errors preserved
 *
 * Mocks the googleapis client at the module boundary so we don't touch real
 * Google APIs and don't need network/credentials.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const valuesGetMock = vi.fn();
const spreadsheetsGetMock = vi.fn(async () => ({
  data: { sheets: [{ properties: { title: 'Tab' } }] },
}));

vi.mock('googleapis', () => {
  return {
    google: {
      sheets: () => ({
        spreadsheets: {
          get: spreadsheetsGetMock,
          values: { get: valuesGetMock, batchGet: vi.fn() },
        },
      }),
    },
  };
});

vi.mock('./oauth-pool.service.js', () => ({
  getOAuthClient: vi.fn(async () => ({})),
}));

vi.mock('./cache.service.js', () => {
  const store = new Map<string, unknown>();
  return {
    __store: store,
    get: vi.fn(async <T>(k: string): Promise<T | undefined> => store.get(k) as T | undefined),
    set: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
    del: vi.fn(async (k: string) => { store.delete(k); }),
    invalidate: vi.fn(async () => {}),
  };
});

import { getRawValues, isRangeOutOfBoundsError } from './google-sheets.service.js';
import { SheetAccessError } from '../lib/errors.js';
import * as cache from './cache.service.js';

const cacheStore = (cache as any).__store as Map<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
});

describe('isRangeOutOfBoundsError', () => {
  it('returns true for code 400 + "exceeds grid limits" message', () => {
    expect(
      isRangeOutOfBoundsError({
        code: 400,
        message: "Range ('Sheet1'!A999999:Z999999) exceeds grid limits. Max rows: 1000, max columns: 26",
      }),
    ).toBe(true);
  });

  it('is case-insensitive on the message check', () => {
    expect(isRangeOutOfBoundsError({ code: 400, message: 'EXCEEDS GRID LIMITS' })).toBe(true);
  });

  it('returns false for code 400 with unrelated message (e.g., malformed)', () => {
    expect(
      isRangeOutOfBoundsError({ code: 400, message: 'Unable to parse range: foo' }),
    ).toBe(false);
  });

  it('returns false for code 403 (auth/permission)', () => {
    expect(isRangeOutOfBoundsError({ code: 403, message: 'exceeds grid limits' })).toBe(false);
  });

  it('returns false for code 404', () => {
    expect(isRangeOutOfBoundsError({ code: 404, message: 'not found' })).toBe(false);
  });

  it('returns false for non-error inputs', () => {
    expect(isRangeOutOfBoundsError(null)).toBe(false);
    expect(isRangeOutOfBoundsError(undefined)).toBe(false);
    expect(isRangeOutOfBoundsError('string error')).toBe(false);
    expect(isRangeOutOfBoundsError(new Error('exceeds grid limits'))).toBe(false); // no `code: 400`
  });
});

describe('getRawValues — out-of-bounds handling', () => {
  function googleOobError() {
    const err: any = new Error("Range ('Tab'!A999999:Z999999) exceeds grid limits. Max rows: 100");
    err.code = 400;
    return err;
  }

  it('returns [] when Google Sheets reports the range exceeds grid limits', async () => {
    valuesGetMock.mockRejectedValueOnce(googleOobError());
    const result = await getRawValues('user-1', 'spreadsheet-1', 'Tab', 'A999999:Z999999');
    expect(result).toEqual([]);
  });

  it('caches the empty slice so repeated OOB hits do not roundtrip to Google', async () => {
    valuesGetMock.mockRejectedValueOnce(googleOobError());
    await getRawValues('user-1', 'spreadsheet-1', 'Tab', 'A999999:Z999999');

    valuesGetMock.mockClear();
    const second = await getRawValues('user-1', 'spreadsheet-1', 'Tab', 'A999999:Z999999');
    expect(second).toEqual([]);
    expect(valuesGetMock).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit when no ?range= was passed (other code paths must keep current behaviour)', async () => {
    const err: any = new Error('exceeds grid limits'); // shouldn't even happen without a range
    err.code = 400;
    valuesGetMock.mockRejectedValueOnce(err);
    await expect(getRawValues('user-1', 'spreadsheet-1', 'Tab')).rejects.toThrow();
  });

  it('preserves SheetAccessError for 403 (permission)', async () => {
    const err: any = new Error('forbidden');
    err.code = 403;
    valuesGetMock.mockRejectedValueOnce(err);
    await expect(getRawValues('user-1', 'spreadsheet-1', 'Tab', 'A1:Z100')).rejects.toBeInstanceOf(SheetAccessError);
  });

  it('preserves SheetAccessError for 404 (not found)', async () => {
    const err: any = new Error('not found');
    err.code = 404;
    valuesGetMock.mockRejectedValueOnce(err);
    await expect(getRawValues('user-1', 'spreadsheet-1', 'Tab', 'A1:Z100')).rejects.toBeInstanceOf(SheetAccessError);
  });

  it('does NOT swallow malformed-range errors (non-OOB 400 keeps rethrowing)', async () => {
    const err: any = new Error('Unable to parse range: bogus');
    err.code = 400;
    valuesGetMock.mockRejectedValueOnce(err);
    // The current contract: non-OOB 400 falls through to handleSheetError →
    // rethrows the original. The global error handler in index.ts maps 4xx
    // statusCodes to AppError, so this stays a 400 in production rather than
    // being masked as an empty 200.
    await expect(getRawValues('user-1', 'spreadsheet-1', 'Tab', 'A1:Z100')).rejects.toThrow(/Unable to parse range/);
  });

  it('returns raw values normally when Google returns data', async () => {
    valuesGetMock.mockResolvedValueOnce({
      data: { values: [['Header'], ['Row1']] },
    });
    const result = await getRawValues('user-1', 'spreadsheet-1', 'Tab', 'A1:Z10');
    expect(result).toEqual([['Header'], ['Row1']]);
  });
});
