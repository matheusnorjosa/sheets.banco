/**
 * Tests for the stable sheetId support (issue #31):
 *   - listSheetMetadata: returns {name, sheet_id, sheet_index}, filters hidden
 *   - resolveTabByIdOrName: ?sheetId= → name; ?sheet= → as-is;
 *     ?sheetId= wins over ?sheet=
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const spreadsheetsGetMock = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    sheets: () => ({
      spreadsheets: {
        get: spreadsheetsGetMock,
        values: { get: vi.fn(), batchGet: vi.fn() },
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

import { listSheetMetadata, resolveTabByIdOrName } from './google-sheets.service.js';
import { AppError } from '../lib/errors.js';
import * as cache from './cache.service.js';
const cacheStore = (cache as any).__store as Map<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
});

function makeResponse(tabs: Array<{ title: string; hidden?: boolean; sheetId?: number; index?: number }>) {
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

describe('listSheetMetadata', () => {
  it('returns name + sheet_id + sheet_index per visible tab', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(makeResponse([
      { title: 'Eventos', sheetId: 11111, index: 0 },
      { title: 'Configurações', sheetId: 22222, index: 1 },
    ]));
    const meta = await listSheetMetadata('user', 'sheet-id');
    expect(meta).toEqual([
      { name: 'Eventos', sheet_id: 11111, sheet_index: 0 },
      { name: 'Configurações', sheet_id: 22222, sheet_index: 1 },
    ]);
  });

  it('filters out hidden tabs (inherits PR #25 policy)', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(makeResponse([
      { title: 'Visible', sheetId: 100 },
      { title: 'Secret', sheetId: 200, hidden: true },
      { title: 'AlsoVisible', sheetId: 300 },
    ]));
    const meta = await listSheetMetadata('user', 'sheet-id');
    expect(meta.map((m) => m.name)).toEqual(['Visible', 'AlsoVisible']);
    expect(meta.find((m) => m.name === 'Secret')).toBeUndefined();
  });

  it('handles missing sheetId field gracefully (assigns null)', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce({
      data: { sheets: [{ properties: { title: 'NoSheetId' } }] },
    });
    const meta = await listSheetMetadata('user', 'sheet-id');
    expect(meta[0]).toMatchObject({ name: 'NoSheetId', sheet_id: null });
  });

  it('caches the result so repeated calls do not roundtrip', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(makeResponse([{ title: 'A', sheetId: 1 }]));
    await listSheetMetadata('user', 'sheet-id');
    spreadsheetsGetMock.mockClear();
    await listSheetMetadata('user', 'sheet-id');
    expect(spreadsheetsGetMock).not.toHaveBeenCalled();
  });

  it('requests the sheetId field from Google (does not rely on luck)', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(makeResponse([]));
    await listSheetMetadata('user', 'sheet-id');
    expect(spreadsheetsGetMock).toHaveBeenCalledWith(
      expect.objectContaining({ fields: expect.stringContaining('sheetId') }),
    );
  });
});

describe('resolveTabByIdOrName', () => {
  beforeEach(() => {
    spreadsheetsGetMock.mockResolvedValue(makeResponse([
      { title: 'Eventos', sheetId: 11111 },
      { title: 'Bloqueios', sheetId: 22222 },
    ]));
  });

  it('returns null when neither ?sheet= nor ?sheetId= is set', async () => {
    expect(await resolveTabByIdOrName('user', 'sheet-id', {})).toBeNull();
  });

  it('?sheet=NAME returns the name as-is (no metadata lookup)', async () => {
    spreadsheetsGetMock.mockClear();
    const out = await resolveTabByIdOrName('user', 'sheet-id', { sheet: 'Bloqueios' });
    expect(out).toBe('Bloqueios');
    expect(spreadsheetsGetMock).not.toHaveBeenCalled();
  });

  it('?sheetId=N resolves to the matching tab name', async () => {
    const out = await resolveTabByIdOrName('user', 'sheet-id', { sheetId: '22222' });
    expect(out).toBe('Bloqueios');
  });

  it('?sheetId= wins over ?sheet= when both are present', async () => {
    const out = await resolveTabByIdOrName('user', 'sheet-id', { sheet: 'Eventos', sheetId: '22222' });
    expect(out).toBe('Bloqueios');
  });

  it('returns null when ?sheetId= matches no visible tab', async () => {
    expect(await resolveTabByIdOrName('user', 'sheet-id', { sheetId: '99999' })).toBeNull();
  });

  it('throws AppError(400 INVALID_SHEET_ID) when ?sheetId= is not an integer', async () => {
    await expect(resolveTabByIdOrName('user', 'sheet-id', { sheetId: 'abc' })).rejects.toBeInstanceOf(AppError);
    await expect(resolveTabByIdOrName('user', 'sheet-id', { sheetId: '1.5' })).rejects.toMatchObject({
      code: 'INVALID_SHEET_ID',
      statusCode: 400,
    });
  });

  it('a hidden tab cannot be resolved by sheetId either (returns null)', async () => {
    spreadsheetsGetMock.mockResolvedValueOnce(makeResponse([
      { title: 'Visible', sheetId: 1 },
      { title: 'Hidden', sheetId: 2, hidden: true },
    ]));
    expect(await resolveTabByIdOrName('user', 'sheet-id', { sheetId: '2' })).toBeNull();
  });
});
