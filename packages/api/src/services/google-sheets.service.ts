import { google, type sheets_v4 } from 'googleapis';
import { NotFoundError, SheetAccessError, AppError } from '../lib/errors.js';
import { processSpecialValues } from '../utils/special-values.js';
import * as cache from './cache.service.js';
import { getOAuthClient } from './oauth-pool.service.js';
import { buildSheetsWithTypes, type SheetWithType } from '../lib/detect/index.js';
import { withBackoff } from './google-backoff.js';
import type { RenderOptions } from '../utils/layout.js';

export type { SheetWithType };

export interface SheetRow {
  [key: string]: string;
}

async function getSheetsClient(userId: string): Promise<sheets_v4.Sheets> {
  const oauth2Client = await getOAuthClient(userId);
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

/**
 * Resolve the sheet tab name. If not provided, fetches the first VISIBLE tab
 * name — hidden tabs are skipped intentionally so the API never surfaces a
 * hidden default. Issue #20 / hidden-sheets policy: hidden tabs do not exist
 * for consumers of this API.
 */
async function resolveSheetName(userId: string, spreadsheetId: string, sheetName?: string): Promise<string> {
  if (sheetName) return sheetName;

  const cacheKey = `firstTab:${spreadsheetId}`;
  const cached = await cache.get<string>(cacheKey);
  if (cached) return cached;

  const sheets = await getSheetsClient(userId);
  const response = await withBackoff(() => sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(title,hidden)',
  }));
  const firstSheet = (response.data.sheets ?? [])
    .find((s) => !s.properties?.hidden)
    ?.properties?.title;
  if (!firstSheet) throw new NotFoundError('Spreadsheet has no visible sheets.');

  await cache.set(cacheKey, firstSheet, 300);
  return firstSheet;
}

/**
 * Build a stable cache-key suffix from render options. When neither value
 * nor dateTime override is requested, returns the empty string so existing
 * cached entries (pre-render-options) stay valid. Otherwise appends a fixed
 * `:<value>:<dateTime>` suffix using `_default` as the placeholder for the
 * option not explicitly overridden.
 */
function renderSuffix(opts?: RenderOptions): string {
  if (!opts?.valueRenderOption && !opts?.dateTimeRenderOption) return '';
  return `:${opts.valueRenderOption ?? '_default'}:${opts.dateTimeRenderOption ?? '_default'}`;
}

/**
 * Extract the first `errors[].reason` from a googleapis error.
 * Empty/missing → undefined. Pure; exported for tests.
 */
export function getErrorReason(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const errors = (err as { errors?: Array<{ reason?: string }> }).errors;
  return Array.isArray(errors) ? errors[0]?.reason : undefined;
}

/**
 * Pull the "enable this API" URL out of an accessNotConfigured error. Tries
 * `errors[].extendedHelp` first (the structured field Google ships), falls
 * back to scanning the human-readable message for a `console.*` URL.
 * Returns undefined if neither is present.
 */
export function extractEnableUrl(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const errors = (err as { errors?: Array<{ extendedHelp?: string }> }).errors;
  if (Array.isArray(errors) && typeof errors[0]?.extendedHelp === 'string') {
    return errors[0].extendedHelp;
  }
  const msg = String((err as { message?: unknown }).message ?? '');
  const m = msg.match(/https?:\/\/console\.[^\s,)]+/);
  return m ? m[0] : undefined;
}

/**
 * Map a googleapis error to an AppError with a stable taxonomy. Recognized
 * Google `reason` values are surfaced as typed 4xx codes; otherwise the
 * pre-existing 403/404 → SheetAccessError fallback applies. Anything else
 * is re-thrown so the global error handler turns it into 500
 * (intentional — we don't want to mask unknown failure modes).
 */
function handleSheetError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof Error && 'code' in error) {
    const code = (error as { code: number }).code;
    const reason = getErrorReason(error);
    const message = String((error as { message?: unknown }).message ?? '');

    // Google Sheets API not enabled for this project. Surface the enable_url
    // so the caller can fix it in one click.
    if (reason === 'accessNotConfigured') {
      const enableUrl = extractEnableUrl(error);
      throw new AppError(
        400,
        'GOOGLE_API_NOT_ENABLED',
        message || 'The Google Sheets API is not enabled in this project.',
        enableUrl ? { enable_url: enableUrl } : undefined,
      );
    }

    // Quota / rate-limit signaling from Google. By the time we get here, the
    // backoff layer (PR #27) has already retried 3× and still failed — pass
    // through as 429 so the consumer knows to slow down.
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
      throw new AppError(429, 'GOOGLE_RATE_LIMIT', message || 'Google rate limit exceeded.');
    }
    if (reason === 'quotaExceeded') {
      throw new AppError(429, 'GOOGLE_QUOTA_EXCEEDED', message || 'Google quota exceeded.');
    }

    // Vanilla permission denied / not found.
    if (code === 403 || code === 404) {
      throw new SheetAccessError();
    }
  }
  throw error;
}

/**
 * Predicate: did Google Sheets reject this call because the A1 range points
 * past the actual grid (e.g., A999999:Z999999 on a tab with 100 rows)?
 *
 * The library surfaces this as an HTTP-400 error with a message like
 *   "Range ('Tab'!A999999:Z999999) exceeds grid limits. Max rows: N, max columns: M"
 *
 * Catching it lets the heavy paths return an empty slice instead of a 500.
 * Deliberately narrow — we only short-circuit on this exact failure mode; any
 * other 400 (malformed range that slipped past sanitizeRange, auth errors,
 * etc.) keeps its current behaviour so we don't mask real problems.
 */
export function isRangeOutOfBoundsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code !== 400) return false;
  const message = String((error as { message?: unknown }).message ?? '');
  return /exceeds grid limits/i.test(message);
}

export async function getRows(
  userId: string,
  spreadsheetId: string,
  sheetName?: string,
  cacheTtl = 60,
  renderOptions?: RenderOptions,
): Promise<SheetRow[]> {
  const renderKey = renderSuffix(renderOptions);
  const cacheKey = `rows:${spreadsheetId}:${sheetName ?? '_default'}${renderKey}`;
  const cached = await cache.get<SheetRow[]>(cacheKey);
  if (cached) return cached;

  try {
    const tab = await resolveSheetName(userId, spreadsheetId, sheetName);
    const sheets = await getSheetsClient(userId);
    const response = await withBackoff(() => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`,
      ...(renderOptions?.valueRenderOption && { valueRenderOption: renderOptions.valueRenderOption }),
      ...(renderOptions?.dateTimeRenderOption && { dateTimeRenderOption: renderOptions.dateTimeRenderOption }),
    }));

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
  await cache.invalidate(`raw:${spreadsheetId}`);
  await cache.invalidate(`allRaw:${spreadsheetId}`);
  await cache.invalidate(`sheetList:${spreadsheetId}`);
  await cache.invalidate(`sheetListTyped:${spreadsheetId}`);
}

/**
 * List all VISIBLE tab names in the spreadsheet. Tabs with
 * `properties.hidden === true` are excluded by design — they don't exist as
 * far as this API's consumers are concerned. Downstream (workbook.json,
 * /report, /export.csv, envelope all-sheets, legacy default) all inherit
 * this filter because they go through listSheetNames.
 *
 * Cache TTL means hide/unhide operations can take up to ~5 minutes to
 * reflect; that trade-off is acceptable vs. blowing the cache on every read.
 */
export async function listSheetNames(
  userId: string,
  spreadsheetId: string,
  cacheTtl = 300,
): Promise<string[]> {
  const cacheKey = `sheetList:${spreadsheetId}`;
  const cached = await cache.get<string[]>(cacheKey);
  if (cached) return cached;

  try {
    const sheets = await getSheetsClient(userId);
    const response = await withBackoff(() => sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties(title,hidden)',
    }));
    const names = (response.data.sheets ?? [])
      .filter((s) => !s.properties?.hidden)
      .map((s) => s.properties?.title)
      .filter((n): n is string => typeof n === 'string');
    await cache.set(cacheKey, names, cacheTtl);
    return names;
  } catch (error) {
    return handleSheetError(error);
  }
}

/**
 * List all tabs with their detected target type. Fetches only the first row
 * of each tab (one batched call) so the consumer can plan per-sheet extraction
 * without paying for cell data first.
 */
export async function listSheetsWithTypes(
  userId: string,
  spreadsheetId: string,
  cacheTtl = 300,
): Promise<SheetWithType[]> {
  const cacheKey = `sheetListTyped:${spreadsheetId}`;
  const cached = await cache.get<SheetWithType[]>(cacheKey);
  if (cached) return cached;

  try {
    const names = await listSheetNames(userId, spreadsheetId, cacheTtl);
    if (names.length === 0) {
      await cache.set(cacheKey, [], cacheTtl);
      return [];
    }
    const sheets = await getSheetsClient(userId);
    // A1 notation: double single quotes inside the tab name.
    const ranges = names.map((n) => `'${n.replace(/'/g, "''")}'!1:1`);
    const response = await withBackoff(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
    }));
    const valueRanges = response.data.valueRanges ?? [];
    const headersByIndex = names.map((_, i) => {
      const firstRow = valueRanges[i]?.values?.[0];
      return Array.isArray(firstRow) ? (firstRow as string[]) : [];
    });
    const result = buildSheetsWithTypes(names, headersByIndex);
    await cache.set(cacheKey, result, cacheTtl);
    return result;
  } catch (error) {
    return handleSheetError(error);
  }
}

/**
 * Get raw 2D values from a single sheet (optionally restricted to a range).
 */
export async function getRawValues(
  userId: string,
  spreadsheetId: string,
  sheetName?: string,
  range?: string,
  cacheTtl = 60,
  renderOptions?: RenderOptions,
): Promise<string[][]> {
  const renderKey = renderSuffix(renderOptions);
  const cacheKey = `raw:${spreadsheetId}:${sheetName ?? '_default'}:${range ?? '_full'}${renderKey}`;
  const cached = await cache.get<string[][]>(cacheKey);
  if (cached) return cached;

  try {
    const tab = await resolveSheetName(userId, spreadsheetId, sheetName);
    const sheets = await getSheetsClient(userId);
    const fullRange = range ? `'${tab}'!${range}` : `'${tab}'`;
    const response = await withBackoff(() => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: fullRange,
      ...(renderOptions?.valueRenderOption && { valueRenderOption: renderOptions.valueRenderOption }),
      ...(renderOptions?.dateTimeRenderOption && { dateTimeRenderOption: renderOptions.dateTimeRenderOption }),
    }));

    const values = (response.data.values as string[][]) ?? [];
    await cache.set(cacheKey, values, cacheTtl);
    return values;
  } catch (error) {
    // Out-of-bounds range with an explicit ?range= → treat as empty slice.
    // Caching prevents repeated hits to Google for the same OOB range while
    // the spreadsheet hasn't changed (invalidated normally on writes).
    if (range && isRangeOutOfBoundsError(error)) {
      await cache.set(cacheKey, [], cacheTtl);
      return [];
    }
    return handleSheetError(error);
  }
}

/**
 * Fetch raw 2D values for ALL tabs in one batch request.
 */
export async function getAllSheetsRaw(
  userId: string,
  spreadsheetId: string,
  cacheTtl = 60,
): Promise<Record<string, string[][]>> {
  const cacheKey = `allRaw:${spreadsheetId}`;
  const cached = await cache.get<Record<string, string[][]>>(cacheKey);
  if (cached) return cached;

  try {
    const names = await listSheetNames(userId, spreadsheetId, cacheTtl);
    if (names.length === 0) return {};

    const sheets = await getSheetsClient(userId);
    const response = await withBackoff(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: names.map((n) => `'${n}'`),
    }));

    const result: Record<string, string[][]> = {};
    const valueRanges = response.data.valueRanges ?? [];
    for (let i = 0; i < names.length; i++) {
      result[names[i]] = (valueRanges[i]?.values as string[][]) ?? [];
    }

    await cache.set(cacheKey, result, cacheTtl);
    return result;
  } catch (error) {
    return handleSheetError(error);
  }
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
    const response = await withBackoff(() => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'!1:1`,
    }));

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
    const response = await withBackoff(() => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`,
    }));

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
  const response = await withBackoff(() => sheets.spreadsheets.get({ spreadsheetId }));
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
    await withBackoff(() => sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${tab}'`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    }));

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
    const response = await withBackoff(() => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`,
    }));

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

        await withBackoff(() => sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${tab}'!A${i + 1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [newRow] },
        }));
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
    const response = await withBackoff(() => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`,
    }));

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

    await withBackoff(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    }));

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
    const response = await withBackoff(() => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`,
    }));

    const allValues = response.data.values;
    if (!allValues || allValues.length < 2) return 0;

    const rowCount = allValues.length - 1;
    const sheetId = await getSheetId(userId, spreadsheetId, tab);

    await withBackoff(() => sheets.spreadsheets.batchUpdate({
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
    }));

    await invalidateCache(spreadsheetId);
    return rowCount;
  } catch (error) {
    return handleSheetError(error);
  }
}
