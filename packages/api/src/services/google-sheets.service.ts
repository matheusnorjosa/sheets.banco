import { google, type sheets_v4 } from 'googleapis';
import { env } from '../config/env.js';
import { NotFoundError, SheetAccessError, AppError } from '../lib/errors.js';
import { processSpecialValues } from '../utils/special-values.js';
import * as cache from './cache.service.js';
import { prisma } from '../lib/prisma.js';

export interface SheetRow {
  [key: string]: string;
}

/**
 * Create an OAuth2 client with user's tokens.
 * Automatically refreshes expired tokens and saves them back to the DB.
 */
async function getSheetsClient(userId: string): Promise<sheets_v4.Sheets> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.googleAccessToken || !user?.googleRefreshToken) {
    throw new AppError(403, 'GOOGLE_NOT_CONNECTED', 'Google account not connected. Please authorize Google access.');
  }

  const oauth2Client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );

  oauth2Client.setCredentials({
    access_token: user.googleAccessToken,
    refresh_token: user.googleRefreshToken,
    expiry_date: user.googleTokenExpiry?.getTime(),
  });

  // Auto-refresh and persist new tokens
  oauth2Client.on('tokens', async (tokens) => {
    const update: any = {};
    if (tokens.access_token) update.googleAccessToken = tokens.access_token;
    if (tokens.refresh_token) update.googleRefreshToken = tokens.refresh_token;
    if (tokens.expiry_date) update.googleTokenExpiry = new Date(tokens.expiry_date);
    if (Object.keys(update).length > 0) {
      await prisma.user.update({ where: { id: userId }, data: update });
    }
  });

  return google.sheets({ version: 'v4', auth: oauth2Client });
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
  const cached = cache.get<SheetRow[]>(cacheKey);
  if (cached) return cached;

  try {
    const sheets = await getSheetsClient(userId);
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

export function invalidateCache(spreadsheetId: string): void {
  cache.invalidate(`rows:${spreadsheetId}`);
  cache.invalidate(`cols:${spreadsheetId}`);
}

export async function getColumnNames(
  userId: string,
  spreadsheetId: string,
  sheetName?: string,
  cacheTtl = 60,
): Promise<string[]> {
  const cacheKey = `cols:${spreadsheetId}:${sheetName ?? '_default'}`;
  const cached = cache.get<string[]>(cacheKey);
  if (cached) return cached;

  try {
    const sheets = await getSheetsClient(userId);
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
  userId: string,
  spreadsheetId: string,
  sheetName?: string,
): Promise<number> {
  try {
    const sheets = await getSheetsClient(userId);
    const range = sheetName ? `'${sheetName}'` : 'Sheet1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
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
    const headers = await getColumnNames(userId, spreadsheetId, sheetName);
    if (headers.length === 0) {
      throw new NotFoundError('Sheet has no headers in the first row.');
    }

    const values = rows.map((row) => {
      const processed = processSpecialValues(row);
      return headers.map((h) => processed[h] ?? '');
    });

    const sheets = await getSheetsClient(userId);
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

export async function updateRows(
  userId: string,
  spreadsheetId: string,
  column: string,
  value: string,
  data: SheetRow,
  sheetName?: string,
): Promise<number> {
  try {
    const sheets = await getSheetsClient(userId);
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
        const newRow = [...row];
        for (const [key, val] of Object.entries(processed)) {
          const ki = headers.indexOf(key);
          if (ki !== -1) newRow[ki] = val;
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

export async function deleteRows(
  userId: string,
  spreadsheetId: string,
  column: string,
  value: string,
  sheetName?: string,
): Promise<number> {
  try {
    const sheets = await getSheetsClient(userId);
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

    const rowIndicesToDelete: number[] = [];
    for (let i = 1; i < allValues.length; i++) {
      if ((allValues[i][colIndex] ?? '') === value) {
        rowIndicesToDelete.push(i);
      }
    }

    if (rowIndicesToDelete.length === 0) return 0;

    const sheetId = await getSheetId(userId, spreadsheetId, sheetName);

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

export async function clearAllRows(
  userId: string,
  spreadsheetId: string,
  sheetName?: string,
): Promise<number> {
  try {
    const sheets = await getSheetsClient(userId);
    const range = sheetName ? `'${sheetName}'` : 'Sheet1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const allValues = response.data.values;
    if (!allValues || allValues.length < 2) return 0;

    const rowCount = allValues.length - 1;
    const sheetId = await getSheetId(userId, spreadsheetId, sheetName);

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

    invalidateCache(spreadsheetId);
    return rowCount;
  } catch (error) {
    return handleSheetError(error);
  }
}
