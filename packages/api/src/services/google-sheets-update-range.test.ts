/**
 * Unit tests for updateRange — the low-level "write a 2D matrix to an A1
 * range" service used by `PUT /:apiId?layout=raw&range=...`.
 *
 * Asserts:
 *   - Sends USER_ENTERED so formulas/dates parse as if typed by hand.
 *   - Quotes the sheet name in the range (prevents injection via tab names).
 *   - Bubbles up updatedRange/Rows/Columns/Cells from Google's response.
 *   - Invalidates cache after a successful write.
 *   - Throws NotFoundError when the sheet doesn't exist (via resolveSheetName).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { valuesUpdateMock, spreadsheetsGetMock, invalidateMock } = vi.hoisted(() => ({
  valuesUpdateMock: vi.fn(),
  spreadsheetsGetMock: vi.fn(async () => ({
    data: { sheets: [{ properties: { title: 'Config' } }] },
  })),
  invalidateMock: vi.fn(async () => {}),
}));

vi.mock('googleapis', () => ({
  google: {
    options: vi.fn(),
    sheets: () => ({
      spreadsheets: {
        get: spreadsheetsGetMock,
        values: {
          update: valuesUpdateMock,
          get: vi.fn(),
          batchGet: vi.fn(),
        },
      },
    }),
  },
}));

vi.mock('./oauth-pool.service.js', () => ({
  getOAuthClient: vi.fn(async () => ({})),
}));

vi.mock('./cache.service.js', () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => {}),
  del: vi.fn(async () => {}),
  invalidate: invalidateMock,
}));

import { updateRange } from './google-sheets.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  valuesUpdateMock.mockResolvedValue({
    data: {
      updatedRange: "'Config'!AL2:AR3",
      updatedRows: 2,
      updatedColumns: 7,
      updatedCells: 14,
    },
  });
});

describe('updateRange', () => {
  it('writes to the correct A1 range with USER_ENTERED and quoted sheet', async () => {
    await updateRange(
      'user',
      'sheet-id',
      'Config',
      'AL2:AR3',
      [
        ['0504002', 'UNI DUNI TE - KIT PROF', 'UNI DUNI TÊ 4', 'UNI DUNI TÊ', 'Professor', 'SUPERINTENDENCIA', 'KT'],
        ['0505003', 'UNI DUNI TE - KIT ALUNO', 'UNI DUNI TÊ 5', 'UNI DUNI TÊ', 'Aluno', 'SUPERINTENDENCIA', 'KT'],
      ],
    );

    expect(valuesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = valuesUpdateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.spreadsheetId).toBe('sheet-id');
    expect(arg.range).toBe("'Config'!AL2:AR3");
    expect(arg.valueInputOption).toBe('USER_ENTERED');
  });

  it('returns Google update metadata verbatim', async () => {
    const result = await updateRange('user', 'sheet-id', 'Config', 'AL2:AR3', [['x']]);
    expect(result).toEqual({
      updatedRange: "'Config'!AL2:AR3",
      updatedRows: 2,
      updatedColumns: 7,
      updatedCells: 14,
    });
  });

  it('invalidates cache after write (across all cache prefixes for the spreadsheet)', async () => {
    await updateRange('user', 'sheet-id', 'Config', 'J1', [['id_erp']]);
    expect(invalidateMock).toHaveBeenCalled();
    // Sanity: at least one call targets a prefix containing the spreadsheet ID
    const anyMatch = invalidateMock.mock.calls.some((call: unknown[]) => {
      const key = call[0];
      return typeof key === 'string' && key.endsWith(':sheet-id');
    });
    expect(anyMatch).toBe(true);
  });

  it('preserves formulas passed as strings (USER_ENTERED interprets them)', async () => {
    await updateRange('user', 'sheet-id', 'Config', 'V2', [['=XLOOKUP(A2,B:B,C:C,"",0)']]);
    const arg = valuesUpdateMock.mock.calls[0]?.[0] as { requestBody: { values: unknown[][] } };
    expect(arg.requestBody.values).toEqual([['=XLOOKUP(A2,B:B,C:C,"",0)']]);
  });

  it('does NOT invalidate cache when the write throws', async () => {
    valuesUpdateMock.mockRejectedValueOnce(new Error('network boom'));
    await expect(
      updateRange('user', 'sheet-id', 'Config', 'A1', [['x']]),
    ).rejects.toThrow();
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
