/**
 * Tests for the hidden-sheets filter introduced in `fix/filter-hidden-sheets`.
 * Hidden tabs (properties.hidden === true) must NOT appear in:
 *   - listSheetNames output
 *   - listSheetsWithTypes output (inherits via listSheetNames)
 *   - resolveSheetName default (legacy /:apiId without ?sheet=)
 *
 * Mocks googleapis at the module boundary so no real Google APIs are hit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const spreadsheetsGetMock = vi.fn();
const valuesGetMock = vi.fn();
const valuesBatchGetMock = vi.fn();

vi.mock('googleapis', () => {
  return {
    google: {
      options: vi.fn(),
      sheets: () => ({
        spreadsheets: {
          get: spreadsheetsGetMock,
          values: { get: valuesGetMock, batchGet: valuesBatchGetMock },
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

import { listSheetNames, listSheetsWithTypes, getRawValues } from './google-sheets.service.js';
import { NotFoundError } from '../lib/errors.js';
import * as cache from './cache.service.js';

const cacheStore = (cache as any).__store as Map<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
});

// Helper: shape a fake Google response with hidden flags by tab. sheetId
// and index are synthesised (i*100+1, i) when not provided — synthetic but
// deterministic, never collides with real Google IDs.
function fakeSpreadsheet(tabs: Array<{ title: string; hidden?: boolean; sheetId?: number; index?: number }>) {
  return {
    data: {
      sheets: tabs.map(({ title, hidden, sheetId, index }, i) => ({
        properties: {
          title,
          ...(hidden !== undefined && { hidden }),
          sheetId: sheetId ?? i * 100 + 1,
          index: index ?? i,
        },
      })),
    },
  };
}

describe('listSheetNames — hidden tabs filter', () => {
  it('excludes tabs with hidden=true', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(
      fakeSpreadsheet([
        { title: 'Visible1' },
        { title: 'Secret',  hidden: true },
        { title: 'Visible2', hidden: false },
      ]),
    );

    const names = await listSheetNames('user', 'sheet-id');
    expect(names).toEqual(['Visible1', 'Visible2']);
  });

  it('keeps tabs with hidden=false', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(
      fakeSpreadsheet([
        { title: 'A', hidden: false },
        { title: 'B', hidden: false },
      ]),
    );
    expect(await listSheetNames('user', 'sheet-id')).toEqual(['A', 'B']);
  });

  it('keeps tabs that have no `hidden` property at all (Google omits the field for visible tabs)', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(
      fakeSpreadsheet([
        { title: 'NoFlag1' },
        { title: 'NoFlag2' },
      ]),
    );
    expect(await listSheetNames('user', 'sheet-id')).toEqual(['NoFlag1', 'NoFlag2']);
  });

  it('requests the hidden field from Google (does not just rely on filtering)', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(fakeSpreadsheet([{ title: 'A' }]));
    await listSheetNames('user', 'sheet-id');
    expect(spreadsheetsGetMock).toHaveBeenCalledWith(
      expect.objectContaining({ fields: expect.stringContaining('hidden') }),
    );
  });

  it('cached entry already excludes hidden tabs', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(
      fakeSpreadsheet([
        { title: 'Visible' },
        { title: 'Secret', hidden: true },
      ]),
    );
    await listSheetNames('user', 'sheet-id');
    // Second call should NOT hit Google again.
    spreadsheetsGetMock.mockClear();
    const second = await listSheetNames('user', 'sheet-id');
    expect(second).toEqual(['Visible']);
    expect(spreadsheetsGetMock).not.toHaveBeenCalled();
  });
});

describe('listSheetsWithTypes — inherits the hidden filter', () => {
  it('does NOT include hidden tabs in the typed listing', async () => {
    // listSheetsWithTypes calls listSheetNames first (which filters hidden),
    // then batchGets the first row of each surviving tab.
    spreadsheetsGetMock.mockResolvedValueOnce(
      fakeSpreadsheet([
        { title: 'Visible',      hidden: false },
        { title: 'HiddenSheet',  hidden: true },
      ]),
    );
    valuesBatchGetMock.mockResolvedValueOnce({
      data: { valueRanges: [{ values: [['Header']] }] }, // only the visible one
    });

    const out = await listSheetsWithTypes('user', 'sheet-id');
    expect(out.map((s) => s.name)).toEqual(['Visible']);
    // batchGet should have been called with only the visible tab's range.
    expect(valuesBatchGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ranges: expect.arrayContaining([expect.stringContaining('Visible')]),
      }),
    );
    // And the hidden tab range must NOT appear.
    const callArg = (valuesBatchGetMock.mock.calls[0]?.[0] ?? {}) as { ranges?: string[] };
    expect((callArg.ranges ?? []).join(' ')).not.toContain('HiddenSheet');
  });
});

describe('resolveSheetName (default tab) — skips hidden when picking the first', () => {
  // resolveSheetName is internal; we exercise it indirectly via getRawValues
  // with no sheetName argument.

  it('picks the first VISIBLE tab when sheetName is omitted', async () => {
    // First call inside getRawValues → resolveSheetName → spreadsheets.get
    spreadsheetsGetMock.mockResolvedValueOnce(
      fakeSpreadsheet([
        { title: 'HiddenFirst', hidden: true },
        { title: 'VisibleSecond' },
      ]),
    );
    valuesGetMock.mockResolvedValueOnce({ data: { values: [['Header'], ['row1']] } });

    await getRawValues('user', 'sheet-id');

    // The range passed to values.get should reference VisibleSecond, not HiddenFirst.
    const callArg = valuesGetMock.mock.calls[0]?.[0] as { range?: string };
    expect(callArg.range).toContain('VisibleSecond');
    expect(callArg.range).not.toContain('HiddenFirst');
  });

  it('throws NotFoundError when every tab is hidden', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(
      fakeSpreadsheet([
        { title: 'A', hidden: true },
        { title: 'B', hidden: true },
      ]),
    );
    await expect(getRawValues('user', 'sheet-id')).rejects.toBeInstanceOf(NotFoundError);
  });
});
