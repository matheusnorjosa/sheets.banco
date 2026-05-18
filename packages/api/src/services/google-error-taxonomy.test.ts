/**
 * Tests for the typed error taxonomy in google-sheets.service.ts:
 *   - getErrorReason: extract `errors[0].reason` safely
 *   - extractEnableUrl: prefer structured `extendedHelp`, fall back to URL
 *     embedded in the message
 *   - handleSheetError (exercised via getRawValues with mocked googleapis):
 *     maps Google reasons to typed 4xx AppErrors instead of 500.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const valuesGetMock = vi.fn();
const spreadsheetsGetMock = vi.fn(async () => ({
  data: { sheets: [{ properties: { title: 'Tab' } }] },
}));

vi.mock('googleapis', () => ({
  google: {
    options: vi.fn(),
    sheets: () => ({
      spreadsheets: {
        get: spreadsheetsGetMock,
        values: { get: valuesGetMock, batchGet: vi.fn() },
      },
    }),
  },
}));

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

import {
  getErrorReason,
  extractEnableUrl,
  getRawValues,
} from './google-sheets.service.js';
import { AppError, SheetAccessError } from '../lib/errors.js';
import * as cache from './cache.service.js';
const cacheStore = (cache as any).__store as Map<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
});

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────────

describe('getErrorReason', () => {
  it('returns the first errors[].reason', () => {
    expect(getErrorReason({ errors: [{ reason: 'accessNotConfigured' }] })).toBe('accessNotConfigured');
  });

  it('returns undefined when errors[] is absent or empty', () => {
    expect(getErrorReason({})).toBeUndefined();
    expect(getErrorReason({ errors: [] })).toBeUndefined();
    expect(getErrorReason({ errors: [{}] })).toBeUndefined();
  });

  it('returns undefined for non-objects', () => {
    expect(getErrorReason(null)).toBeUndefined();
    expect(getErrorReason(undefined)).toBeUndefined();
    expect(getErrorReason('string')).toBeUndefined();
  });
});

describe('extractEnableUrl', () => {
  it('prefers the structured extendedHelp field', () => {
    const url = extractEnableUrl({
      errors: [{ extendedHelp: 'https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=999' }],
      message: 'noise',
    });
    expect(url).toBe('https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=999');
  });

  it('falls back to scanning the message for a console.* URL', () => {
    const url = extractEnableUrl({
      message: 'Google Sheets API has not been used in project X before. Enable it by visiting https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=42 then retry.',
    });
    expect(url).toBe('https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=42');
  });

  it('returns undefined when neither path matches', () => {
    expect(extractEnableUrl({ message: 'no url here' })).toBeUndefined();
    expect(extractEnableUrl({})).toBeUndefined();
    expect(extractEnableUrl(null)).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handleSheetError via getRawValues with mocked googleapis errors
// ────────────────────────────────────────────────────────────────────────────

function fakeError(opts: { code: number; message?: string; reason?: string; extendedHelp?: string }) {
  const err: any = new Error(opts.message ?? 'error');
  err.code = opts.code;
  if (opts.reason || opts.extendedHelp) {
    err.errors = [{ reason: opts.reason, extendedHelp: opts.extendedHelp }];
  }
  return err;
}

describe('handleSheetError taxonomy via getRawValues', () => {
  it('accessNotConfigured → 400 GOOGLE_API_NOT_ENABLED with enable_url in details', async () => {
    valuesGetMock.mockRejectedValueOnce(fakeError({
      code: 403,
      message: 'Google Sheets API has not been used in project 42 before...',
      reason: 'accessNotConfigured',
      extendedHelp: 'https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=42',
    }));
    await expect(getRawValues('user', 'sheet-id', 'Tab', 'A1:Z10')).rejects.toMatchObject({
      statusCode: 400,
      code: 'GOOGLE_API_NOT_ENABLED',
      details: { enable_url: 'https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=42' },
    });
  });

  it('accessNotConfigured without extendedHelp still works (URL parsed from message)', async () => {
    valuesGetMock.mockRejectedValueOnce(fakeError({
      code: 403,
      message: 'Enable via https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=99 to proceed',
      reason: 'accessNotConfigured',
    }));
    const err = await getRawValues('user', 'sheet-id', 'Tab', 'A1:Z10').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('GOOGLE_API_NOT_ENABLED');
    expect(err.details?.enable_url).toContain('project=99');
  });

  it('rateLimitExceeded → 429 GOOGLE_RATE_LIMIT', async () => {
    valuesGetMock.mockRejectedValue(fakeError({ code: 403, reason: 'rateLimitExceeded', message: 'rate' }));
    // PR #27 retries 3× before giving up. Final throw reaches handleSheetError.
    await expect(getRawValues('user', 'sheet-id', 'Tab', 'A1:Z10')).rejects.toMatchObject({
      statusCode: 429,
      code: 'GOOGLE_RATE_LIMIT',
    });
  });

  it('userRateLimitExceeded → 429 GOOGLE_RATE_LIMIT', async () => {
    valuesGetMock.mockRejectedValue(fakeError({ code: 403, reason: 'userRateLimitExceeded' }));
    await expect(getRawValues('user', 'sheet-id', 'Tab', 'A1:Z10')).rejects.toMatchObject({
      statusCode: 429,
      code: 'GOOGLE_RATE_LIMIT',
    });
  });

  it('quotaExceeded → 429 GOOGLE_QUOTA_EXCEEDED', async () => {
    valuesGetMock.mockRejectedValue(fakeError({ code: 403, reason: 'quotaExceeded' }));
    await expect(getRawValues('user', 'sheet-id', 'Tab', 'A1:Z10')).rejects.toMatchObject({
      statusCode: 429,
      code: 'GOOGLE_QUOTA_EXCEEDED',
    });
  });

  it('vanilla 403 (no reason) → SheetAccessError (preserves existing contract)', async () => {
    valuesGetMock.mockRejectedValueOnce(fakeError({ code: 403, message: 'forbidden' }));
    await expect(getRawValues('user', 'sheet-id', 'Tab', 'A1:Z10')).rejects.toBeInstanceOf(SheetAccessError);
  });

  it('vanilla 404 → SheetAccessError (preserves existing contract)', async () => {
    valuesGetMock.mockRejectedValueOnce(fakeError({ code: 404, message: 'not found' }));
    await expect(getRawValues('user', 'sheet-id', 'Tab', 'A1:Z10')).rejects.toBeInstanceOf(SheetAccessError);
  });

  it('unknown 4xx without recognized reason → re-thrown (becomes 500 via global handler)', async () => {
    valuesGetMock.mockRejectedValueOnce(fakeError({ code: 400, message: 'Unable to parse range: weird' }));
    await expect(getRawValues('user', 'sheet-id', 'Tab', 'A1:Z10')).rejects.toThrow(/Unable to parse range/);
  });
});
