import { google } from 'googleapis';
import { env } from '../config/env.js';
import { NotFoundError, SheetAccessError } from '../lib/errors.js';
import { processSpecialValues } from '../utils/special-values.js';
import * as cache from './cache.service.js';

const auth = new google.auth.JWT({
  email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

export interface SheetRow {
  [key: string]: string;
}

function handleSheetError(error: unknown): never {
  if (error instanceof Error && 'code' in error) {
    const code = (error as { code: number }).code;
    if (code === 403 || code === 404) {
      throw new SheetAccessError();
    }
  }
  throw error;
}

export async function getRows(
  spreadsheetId: string,
  sheetName?: string,
  cacheTtl = 60,
): Promise<SheetRow[]> {
  const cacheKey = `rows:${spreadsheetId}:${sheetName ?? '_default'}`;
  const cached = cache.get<SheetRow[]>(cacheKey);
  if (cached) return cached;

  try {
    const range = sheetName ? `'${sheetName}'` : 'Sheet1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const values = response.data.values;
    if (!values || values.length < 2) return [];

    const headers = values[0] as string[];
    const rows = values.slice(1).map((row) => {
      const obj: SheetRow = {};
      for (let i = 0; i < headers.length; i++) {
        obj[headers[i]] = row[i] ?? '';
      }
      return obj;
    });

    cache.set(cacheKey, rows, cacheTtl);
    return rows;
  } catch (error) {
    return handleSheetError(error);
  }
}

/**
 * Invalidate cache for a spreadsheet (called after writes).
 */
export function invalidateCache(spreadsheetId: string): void {
  cache.invalidate(`rows:${spreadsheetId}`);
  cache.invalidate(`cols:${spreadsheetId}`);
}

export async function getColumnNames(
  spreadsheetId: string,
  sheetName?: string,
  cacheTtl = 60,
): Promise<string[]> {
  const cacheKey = `cols:${spreadsheetId}:${sheetName ?? '_default'}`;
  const cached = cache.get<string[]>(cacheKey);
  if (cached) return cached;

  try {
    const range = sheetName ? `'${sheetName}'!1:1` : 'Sheet1!1:1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const columns = (response.data.values?.[0] as string[]) ?? [];
    cache.set(cacheKey, columns, cacheTtl);
    return columns;
  } catch (error) {
    return handleSheetError(error);
  }
}

export async function getRowCount(
  spreadsheetId: string,
  sheetName?: string,
): Promise<number> {
  try {
    const range = sheetName ? `'${sheetName}'` : 'Sheet1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const values = response.data.values;
    if (!values || values.length < 2) return 0;

    return values.length - 1; // exclude header row
  } catch (error) {
    return handleSheetError(error);
  }
}

/**
 * Resolve a sheet tab name to its numeric sheetId (needed for delete operations).
 */
async function getSheetId(
  spreadsheetId: string,
  sheetName?: string,
): Promise<number> {
  const response = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetsList = response.data.sheets ?? [];

  if (!sheetName) {
    return sheetsList[0]?.properties?.sheetId ?? 0;
  }

  const found = sheetsList.find((s) => s.properties?.title === sheetName);
  if (!found) {
    throw new NotFoundError(`Sheet tab "${sheetName}" not found.`);
  }
  return found.properties?.sheetId ?? 0;
}

/**
 * Append rows to the sheet.
 */
export async function appendRows(
  spreadsheetId: string,
  rows: SheetRow[],
  sheetName?: string,
): Promise<number> {
  try {
    const headers = await getColumnNames(spreadsheetId, sheetName);
    if (headers.length === 0) {
      throw new NotFoundError('Sheet has no headers in the first row.');
    }

    const values = rows.map((row) => {
      const processed = processSpecialValues(row);
      return headers.map((h) => processed[h] ?? '');
    });

    const range = sheetName ? `'${sheetName}'` : 'Sheet1';
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    invalidateCache(spreadsheetId);
    return rows.length;
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    return handleSheetError(error);
  }
}

/**
 * Update rows where `column` equals `value`.
 */
export async function updateRows(
  spreadsheetId: string,
  column: string,
  value: string,
  data: SheetRow,
  sheetName?: string,
): Promise<number> {
  try {
    const range = sheetName ? `'${sheetName}'` : 'Sheet1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const allValues = response.data.values;
    if (!allValues || allValues.length < 2) return 0;

    const headers = allValues[0] as string[];
    const colIndex = headers.indexOf(column);
    if (colIndex === -1) {
      throw new NotFoundError(`Column "${column}" not found.`);
    }

    let updated = 0;
    const processed = processSpecialValues(data);

    for (let i = 1; i < allValues.length; i++) {
      const row = allValues[i];
      if ((row[colIndex] ?? '') === value) {
        // Merge existing row with updates
        const newRow = [...row];
        for (const [key, val] of Object.entries(processed)) {
          const ki = headers.indexOf(key);
          if (ki !== -1) {
            // Handle INCREMENT: add to current value
            if (data[key] === 'INCREMENT') {
              newRow[ki] = val; // processSpecialValues already handled it
            } else {
              newRow[ki] = val;
            }
          }
        }

        const rowRange = sheetName
          ? `'${sheetName}'!A${i + 1}`
          : `Sheet1!A${i + 1}`;
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: rowRange,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [newRow] },
        });
        updated++;
      }
    }

    if (updated > 0) invalidateCache(spreadsheetId);
    return updated;
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    return handleSheetError(error);
  }
}

/**
 * Delete rows where `column` equals `value`.
 */
export async function deleteRows(
  spreadsheetId: string,
  column: string,
  value: string,
  sheetName?: string,
): Promise<number> {
  try {
    const range = sheetName ? `'${sheetName}'` : 'Sheet1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const allValues = response.data.values;
    if (!allValues || allValues.length < 2) return 0;

    const headers = allValues[0] as string[];
    const colIndex = headers.indexOf(column);
    if (colIndex === -1) {
      throw new NotFoundError(`Column "${column}" not found.`);
    }

    // Find matching row indices (0-based in the sheet, header is row 0)
    const rowIndicesToDelete: number[] = [];
    for (let i = 1; i < allValues.length; i++) {
      if ((allValues[i][colIndex] ?? '') === value) {
        rowIndicesToDelete.push(i);
      }
    }

    if (rowIndicesToDelete.length === 0) return 0;

    const sheetId = await getSheetId(spreadsheetId, sheetName);

    // Delete from bottom to top to avoid index shifting
    const requests = rowIndicesToDelete.reverse().map((rowIndex) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS' as const,
          startIndex: rowIndex,
          endIndex: rowIndex + 1,
        },
      },
    }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });

    invalidateCache(spreadsheetId);
    return rowIndicesToDelete.length;
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    return handleSheetError(error);
  }
}

/**
 * Clear all data rows (keeps headers).
 */
export async function clearAllRows(
  spreadsheetId: string,
  sheetName?: string,
): Promise<number> {
  try {
    const range = sheetName ? `'${sheetName}'` : 'Sheet1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const allValues = response.data.values;
    if (!allValues || allValues.length < 2) return 0;

    const rowCount = allValues.length - 1;
    const sheetId = await getSheetId(spreadsheetId, sheetName);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: 1, // keep header
                endIndex: allValues.length,
              },
            },
          },
        ],
      },
    });

    invalidateCache(spreadsheetId);
    return rowCount;
  } catch (error) {
    return handleSheetError(error);
  }
}
