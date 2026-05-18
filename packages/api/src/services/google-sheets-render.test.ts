/**
 * Integration tests for the valueRenderOption / dateTimeRenderOption
 * pass-through in getRawValues. Asserts:
 *   - Default call (no renderOptions): no `valueRenderOption` /
 *     `dateTimeRenderOption` keys sent to googleapis (Google falls back to
 *     FORMATTED_VALUE / SERIAL_NUMBER as today).
 *   - With render options: the mapped enum reaches googleapis verbatim.
 *   - Cache key differs across render modes (no cross-contamination).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const spreadsheetsGetMock = vi.fn(async () => ({
  data: { sheets: [{ properties: { title: 'Tab' } }] },
}));
const valuesGetMock = vi.fn();

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

import { getRawValues } from './google-sheets.service.js';
import * as cache from './cache.service.js';
const cacheStore = (cache as any).__store as Map<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
  valuesGetMock.mockResolvedValue({ data: { values: [['Header'], ['row1']] } });
});

describe('getRawValues — render option forwarding', () => {
  it('default call: no render keys reach googleapis (preserves today behavior)', async () => {
    await getRawValues('user', 'sheet-id', 'Tab', undefined, 60);
    const callArg = valuesGetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg).toBeDefined();
    expect('valueRenderOption' in callArg).toBe(false);
    expect('dateTimeRenderOption' in callArg).toBe(false);
  });

  it('forwards valueRenderOption when provided', async () => {
    await getRawValues('user', 'sheet-id', 'Tab', undefined, 60, {
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const callArg = valuesGetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.valueRenderOption).toBe('UNFORMATTED_VALUE');
    expect('dateTimeRenderOption' in callArg).toBe(false);
  });

  it('forwards dateTimeRenderOption when provided', async () => {
    await getRawValues('user', 'sheet-id', 'Tab', undefined, 60, {
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    const callArg = valuesGetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.dateTimeRenderOption).toBe('SERIAL_NUMBER');
  });

  it('forwards both when provided', async () => {
    await getRawValues('user', 'sheet-id', 'Tab', undefined, 60, {
      valueRenderOption: 'FORMULA',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const callArg = valuesGetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.valueRenderOption).toBe('FORMULA');
    expect(callArg.dateTimeRenderOption).toBe('FORMATTED_STRING');
  });

  it('different render options use different cache keys (no cross-contamination)', async () => {
    await getRawValues('user', 'sheet-id', 'Tab', undefined, 60);
    await getRawValues('user', 'sheet-id', 'Tab', undefined, 60, { valueRenderOption: 'UNFORMATTED_VALUE' });
    // Two distinct google calls — second wasn't served from cache.
    expect(valuesGetMock).toHaveBeenCalledTimes(2);
    // And two distinct cache entries.
    expect(cacheStore.size).toBe(2);
  });

  it('same render options hit the cache on the second call', async () => {
    await getRawValues('user', 'sheet-id', 'Tab', undefined, 60, { valueRenderOption: 'UNFORMATTED_VALUE' });
    valuesGetMock.mockClear();
    await getRawValues('user', 'sheet-id', 'Tab', undefined, 60, { valueRenderOption: 'UNFORMATTED_VALUE' });
    expect(valuesGetMock).not.toHaveBeenCalled();
  });

  it('cache key unchanged from pre-#28 behavior when no render is set', async () => {
    await getRawValues('user', 'sheet-id', 'Tab', undefined, 60);
    // Existing key pattern: `raw:<spreadsheet>:<sheet>:<range>` — no render suffix.
    expect(Array.from(cacheStore.keys())).toEqual(['raw:sheet-id:Tab:_full']);
  });
});
