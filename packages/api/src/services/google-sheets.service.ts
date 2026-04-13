import { google, type sheets_v4 } from 'googleapis';
import { env } from '../config/env.js';
import { SheetAccessError } from '../lib/errors.js';

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
): Promise<SheetRow[]> {
  try {
    const range = sheetName ? `'${sheetName}'` : 'Sheet1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const values = response.data.values;
    if (!values || values.length < 2) return [];

    const headers = values[0] as string[];
    return values.slice(1).map((row) => {
      const obj: SheetRow = {};
      for (let i = 0; i < headers.length; i++) {
        obj[headers[i]] = row[i] ?? '';
      }
      return obj;
    });
  } catch (error) {
    return handleSheetError(error);
  }
}

export async function getColumnNames(
  spreadsheetId: string,
  sheetName?: string,
): Promise<string[]> {
  try {
    const range = sheetName ? `'${sheetName}'!1:1` : 'Sheet1!1:1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    return (response.data.values?.[0] as string[]) ?? [];
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
