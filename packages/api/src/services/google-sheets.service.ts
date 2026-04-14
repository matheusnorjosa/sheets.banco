import { google, type sheets_v4 } from 'googleapis';
import { env } from '../config/env.js';
import { NotFoundError, SheetAccessError, AppError } from '../lib/errors.js';
import { processSpecialValues } from '../utils/special-values.js';
import * as cache from './cache.service.js';
import { getOAuthClient } from './oauth-pool.service.js';

export interface SheetRow {
  [key: string]: string;
}

async function getSheetsClient(userId: string): Promise<sheets_v4.Sheets> {
  const oauth2Client = await getOAuthClient(userId);
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

/**
 * Resolve the sheet tab name. If not provided, fetches the first tab name.
 */
async function resolveSheetName(userId: string, spreadsheetId: string, sheetName?: string): Promise<string> {
  if (sheetName) return sheetName;

  const cacheKey = `firstTab:${spreadsheetId}`;
  const cached = await cache.get<string>(cacheKey);
  if (cached) return cached;

  const sheets = await getSheetsClient(userId);
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  const firstSheet = response.data.sheets?.[0]?.properties?.title;
  if (!firstSheet) throw new NotFoundError('Spreadsheet has no sheets.');

  await cache.set(cacheKey, firstSheet, 300);
  return firstSheet;
}

function handleSheetError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof Error && 'code' in error) {
    const code = (error as { code: number }).code;
    if (code === 403 || code === 404) {
      throw new SheetAccessError();
    }
  }
  throw error;
}

export async function getRows(
  userId: string,
  spreadsheetId: string,
  sheetName?: string,
  cacheTtl = 60,
): Promise<SheetRow[]> {
  const cacheKey = `rows:${spreadsheetId}:${sheetName ?? '_default'}`;
  const cached = await cache.get<SheetRow[]>(cacheKey);
  if (cached) return cached;

  try {
    const tab = await resolveSheetName(userId, spreadsheetId, sheetName);
    const sheets = await getSheetsClient(userId);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`,
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

    await cache.set(cacheKey, rows, cacheTtl);
    return rows;
  } catch (error) {
    return handleSheetError(error);
  }
}

export async function invalidateCache(spreadsheetId: string): Promise<void> {
  await cache.invalidate(`rows:${spreadsheetId}`);
  await cache.invalidate(`cols:${spreadsheetId}`);
}

export async function getColumnNames(
  userId: string,
  spreadsheetId: string,
  sheetName?: string,
  cacheTtl = 60,
): Promise<string[]> {
  const cacheKey = `cols:${spreadsheetId}:${sheetName ?? '_default'}`;
  const cached = await cache.get<string[]>(cacheKey);
  if (cached) return cached;

  try {
    const tab = await resolveSheetName(userId, spreadsheetId, sheetName);
    const sheets = await getSheetsClient(userId);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'!1:1`,
    });

    const columns = (response.data.values?.[0] as string[]) ?? [];
    await cache.set(cacheKey, columns, cacheTtl);
    return columns;
  } catch (error) {
    return handleSheetError(error);
  }
}

export async function getRowCount(
  userId: string,
  spreadsheetId: string,
  sheetName?: string,
): Promise<number> {
  try {
    const tab = await resolveSheetName(userId, spreadsheetId, sheetName);
    const sheets = await getSheetsClient(userId);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`,
    });

    const values = response.data.values;
    if (!values || values.length < 2) return 0;
    return values.length - 1;
  } catch (error) {
    return handleSheetError(error);
  }
}

async function getSheetId(
  userId: string,
  spreadsheetId: string,
  sheetName?: string,
): Promise<number> {
  const sheets = await getSheetsClient(userId);
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

export async function appendRows(
  userId: string,
  spreadsheetId: string,
  rows: SheetRow[],
  sheetName?: string,
): Promise<number> {
  try {
    const tab = await resolveSheetName(userId, spreadsheetId, sheetName);
    const headers = await getColumnNames(userId, spreadsheetId, tab);
    if (headers.length === 0) {
      throw new NotFoundError('Sheet has no headers in the first row.');
    }

    const values = rows.map((row) => {
      const processed = processSpecialValues(row);
      return headers.map((h) => processed[h] ?? '');
    });

    const sheets = await getSheetsClient(userId);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${tab}'`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    await invalidateCache(spreadsheetId);
    return rows.length;
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    return handleSheetError(error);
  }
}

export async function updateRows(
  userId: string,
  spreadsheetId: string,
  column: string,
  value: string,
  data: SheetRow,
  sheetName?: string,
): Promise<number> {
  try {
    const tab = await resolveSheetName(userId, spreadsheetId, sheetName);
    const sheets = await getSheetsClient(userId);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`,
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
        const newRow = [...row];
        for (const [key, val] of Object.entries(processed)) {
          const ki = headers.indexOf(key);
          if (ki !== -1) newRow[ki] = val;
        }

        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${tab}'!A${i + 1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [newRow] },
        });
        updated++;
      }
    }

    if (updated > 0) await invalidateCache(spreadsheetId);
    return updated;
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    return handleSheetError(error);
  }
}

export async function deleteRows(
  userId: string,
  spreadsheetId: string,
  column: string,
  value: string,
  sheetName?: string,
): Promise<number> {
  try {
    const tab = await resolveSheetName(userId, spreadsheetId, sheetName);
    const sheets = await getSheetsClient(userId);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`,
    });

    const allValues = response.data.values;
    if (!allValues || allValues.length < 2) return 0;

    const headers = allValues[0] as string[];
    const colIndex = headers.indexOf(column);
    if (colIndex === -1) {
      throw new NotFoundError(`Column "${column}" not found.`);
    }

    const rowIndicesToDelete: number[] = [];
    for (let i = 1; i < allValues.length; i++) {
      if ((allValues[i][colIndex] ?? '') === value) {
        rowIndicesToDelete.push(i);
      }
    }

    if (rowIndicesToDelete.length === 0) return 0;

    const sheetId = await getSheetId(userId, spreadsheetId, tab);

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

    await invalidateCache(spreadsheetId);
    return rowIndicesToDelete.length;
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    return handleSheetError(error);
  }
}

export async function clearAllRows(
  userId: string,
  spreadsheetId: string,
  sheetName?: string,
): Promise<number> {
  try {
    const tab = await resolveSheetName(userId, spreadsheetId, sheetName);
    const sheets = await getSheetsClient(userId);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`,
    });

    const allValues = response.data.values;
    if (!allValues || allValues.length < 2) return 0;

    const rowCount = allValues.length - 1;
    const sheetId = await getSheetId(userId, spreadsheetId, tab);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: 1,
                endIndex: allValues.length,
              },
            },
          },
        ],
      },
    });

    await invalidateCache(spreadsheetId);
    return rowCount;
  } catch (error) {
    return handleSheetError(error);
  }
}
