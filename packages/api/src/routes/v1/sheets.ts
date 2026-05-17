import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError, AppError } from '../../lib/errors.js';
import * as sheetsService from '../../services/google-sheets.service.js';
import { buildFilters, filterAnd, filterOr } from '../../utils/query-parser.js';
import { applyPagination, castNumbers } from '../../utils/pagination.js';
import { applyLayout, isLayout, sanitizeRange, type Layout } from '../../utils/layout.js';
import { buildEnvelope, rowsFromValues } from '../../lib/envelope/build.js';
import { buildAprenderSistemaTarget, TARGET_NAME as APRENDER_TARGET } from '../../lib/targets/aprenderSistema/index.js';
import { buildAprenderSistemaReport } from '../../lib/targets/aprenderSistema/report.js';
import {
  buildCsvFilename,
  streamTargetCsv,
  validateCsvExportQuery,
} from '../../lib/targets/aprenderSistema/csv.js';
import { findSheetApiCached } from '../../services/sheet-api-cache.service.js';
import { apiAuth } from '../../middleware/api-auth.js';
import { apiCors } from '../../middleware/cors.js';
import { apiIpWhitelist } from '../../middleware/ip-whitelist.js';
import { apiRateLimitOptions } from '../../middleware/rate-limiter.js';
import { hmacVerify } from '../../middleware/hmac-verify.js';
import { enqueueWrite } from '../../queues/sheets-write.queue.js';
import { applyComputedFields } from '../../utils/computed-fields.js';

const createBodySchema = z.object({
  data: z.union([
    z.record(z.string(), z.string()),
    z.array(z.record(z.string(), z.string())),
  ]),
});

const updateBodySchema = z.object({
  data: z.record(z.string(), z.string()),
});

interface SheetApiRecord {
  id: string;
  spreadsheetId: string;
  userId: string | null;
  cacheTtlSeconds: number;
  allowRead: boolean;
  allowCreate: boolean;
  allowUpdate: boolean;
  allowDelete: boolean;
  autoSnapshotOnWrite: boolean;
}

function getSheetApi(request: any): SheetApiRecord {
  return request.sheetApi as SheetApiRecord;
}

function getUserId(request: any): string {
  const sheetApi = getSheetApi(request);
  if (!sheetApi.userId) {
    throw new AppError(500, 'NO_OWNER', 'This API has no owner configured.');
  }
  return sheetApi.userId;
}

function getQueryParams(request: any) {
  return (request.query ?? {}) as Record<string, string>;
}

async function getComputedFieldsForApi(sheetApiId: string) {
  return prisma.computedField.findMany({
    where: { sheetApiId },
    select: { name: true, expression: true },
  });
}

/**
 * Resolve which spreadsheetId to use.
 * If ?source=<additionalSheetId> is provided, use that additional spreadsheet.
 */
async function resolveSpreadsheetId(sheetApi: SheetApiRecord & { id?: string }, query: Record<string, string>): Promise<string> {
  if (query.source) {
    const additional = await prisma.additionalSheet.findFirst({
      where: { id: query.source, sheetApiId: (sheetApi as any).id },
    });
    if (additional) return additional.spreadsheetId;
  }
  return sheetApi.spreadsheetId;
}

export async function sheetsRoutes(app: FastifyInstance) {
  // Apply per-API rate limiting
  app.register(import('@fastify/rate-limit'), apiRateLimitOptions() as any);

  // Resolve SheetApi from :apiId param (supports both ID and slug). Goes
  // through a Redis-backed cache so the hot path on every request doesn't
  // wake Neon — was the #1 driver of CU-hour burn before this change.
  app.addHook('onRequest', async (request) => {
    const { apiId } = request.params as { apiId?: string };
    if (!apiId) return;

    const sheetApi = await findSheetApiCached(apiId);
    if (!sheetApi) {
      throw new NotFoundError('API not found. Check your API ID or slug.');
    }

    (request as any).sheetApi = sheetApi;
  });

  // Per-API security: CORS, IP whitelist, auth, HMAC
  app.addHook('onRequest', apiCors);
  app.addHook('onRequest', apiIpWhitelist);
  app.addHook('onRequest', apiAuth);
  app.addHook('onRequest', hmacVerify);

  // GET /:apiId — return all rows (with pagination)
  // Supports ?version=N to return snapshot data
  // Supports ?source=<additionalSheetId> for multi-spreadsheet
  // Supports ?include_computed=false to exclude computed fields
  app.get('/:apiId', async (request) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    const sheetName = query.sheet;

    // Snapshot version support
    if (query.version) {
      const snapshot = await prisma.snapshot.findUnique({
        where: {
          sheetApiId_version: {
            sheetApiId: sheetApi.id,
            version: Number(query.version),
          },
        },
      });
      if (!snapshot) throw new NotFoundError(`Snapshot version ${query.version} not found.`);
      let rows = snapshot.data as sheetsService.SheetRow[];

      rows = applyPagination(rows, {
        limit: query.limit ? Number(query.limit) : undefined,
        offset: query.offset ? Number(query.offset) : undefined,
        sort_by: query.sort_by,
        sort_order: query.sort_order as 'asc' | 'desc' | 'random' | undefined,
        cast_numbers: query.cast_numbers === 'true',
      });

      if (query.cast_numbers === 'true') return castNumbers(rows);
      if (query.single_object === 'true' && rows.length > 0) return rows[0];
      return rows;
    }

    // Multi-spreadsheet support
    const spreadsheetId = await resolveSpreadsheetId(sheetApi, query);

    // Layout & range params
    const layout: Layout = isLayout(query.layout) ? query.layout : 'table';
    let range: string | undefined;
    try {
      range = sanitizeRange(query.range);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }

    // ?envelope=v1 — structured envelope with normalization, validation, hashes.
    // Opt-in only; default response stays a flat array for backward compatibility.
    if (query.envelope === 'v1') {
      const apiName = (sheetApi as any).name || sheetApi.id;
      let envelope;
      if (sheetName) {
        const values = await sheetsService.getRawValues(
          userId, spreadsheetId, sheetName, range, sheetApi.cacheTtlSeconds,
        );
        envelope = buildEnvelope({
          apiId: sheetApi.id,
          apiName,
          sheets: [{ name: sheetName, rows: rowsFromValues(values) }],
        });
      } else {
        const allRaw = await sheetsService.getAllSheetsRaw(userId, spreadsheetId, sheetApi.cacheTtlSeconds);
        envelope = buildEnvelope({
          apiId: sheetApi.id,
          apiName,
          sheets: Object.entries(allRaw).map(([name, values]) => ({
            name,
            rows: rowsFromValues(values),
          })),
        });
      }

      // ?target=<name> attaches a target-shaped projection to the envelope.
      // Unknown targets are a client error so consumers fail loudly instead
      // of silently getting the base envelope.
      if (query.target) {
        if (query.target !== APRENDER_TARGET) {
          throw new AppError(400, 'UNSUPPORTED_TARGET', `Unsupported target: "${query.target}". Available: ${APRENDER_TARGET}.`);
        }
        return { ...envelope, target: buildAprenderSistemaTarget(envelope) };
      }

      return envelope;
    }

    // ?all_sheets=true — return data from every tab keyed by tab name
    if (query.all_sheets === 'true') {
      const allRaw = await sheetsService.getAllSheetsRaw(userId, spreadsheetId, sheetApi.cacheTtlSeconds);
      const result: Record<string, unknown> = {};
      for (const [tabName, values] of Object.entries(allRaw)) {
        result[tabName] = applyLayout(values, layout);
      }
      return result;
    }

    // Non-table layouts: skip filters/computed/pagination (they don't apply)
    if (layout === 'raw' || layout === 'matrix') {
      const values = await sheetsService.getRawValues(
        userId, spreadsheetId, sheetName, range, sheetApi.cacheTtlSeconds,
      );
      return applyLayout(values, layout);
    }

    // Default: table layout (current behavior)
    let rows: sheetsService.SheetRow[];
    if (range) {
      const values = await sheetsService.getRawValues(
        userId, spreadsheetId, sheetName, range, sheetApi.cacheTtlSeconds,
      );
      rows = applyLayout(values, 'table') as sheetsService.SheetRow[];
    } else {
      rows = await sheetsService.getRows(userId, spreadsheetId, sheetName, sheetApi.cacheTtlSeconds);
    }

    // Apply computed fields (default: true)
    if (query.include_computed !== 'false') {
      const computedFields = await getComputedFieldsForApi(sheetApi.id);
      rows = applyComputedFields(rows, computedFields);
    }

    rows = applyPagination(rows, {
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
      sort_by: query.sort_by,
      sort_order: query.sort_order as 'asc' | 'desc' | 'random' | undefined,
      cast_numbers: query.cast_numbers === 'true',
    });

    if (query.cast_numbers === 'true') return castNumbers(rows);
    if (query.single_object === 'true' && rows.length > 0) return rows[0];
    return rows;
  });

  // GET /:apiId/sheets — list all tab names.
  // ?include=types enriches each entry with detected_type + columns by fetching
  // just the header row of every tab. Lets consumers plan per-sheet extraction
  // without paying for cell data first.
  app.get('/:apiId/sheets', async (request) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    const spreadsheetId = await resolveSpreadsheetId(sheetApi, query);
    if (query.include === 'types') {
      const typed = await sheetsService.listSheetsWithTypes(userId, spreadsheetId);
      return { sheets: typed };
    }
    const names = await sheetsService.listSheetNames(userId, spreadsheetId);
    return { sheets: names };
  });

  // Shared envelope builder for /report and /export.csv. When ?sheet=<name> is
  // present we fetch and process that one tab only — bounds memory per request
  // regardless of how big the spreadsheet grows. Without it we fall back to
  // the legacy "all sheets" behaviour (kept for backward compat; documented as
  // for small spreadsheets only).
  async function buildTargetEnvelope(
    sheetApi: SheetApiRecord,
    userId: string,
    query: Record<string, string>,
  ) {
    const apiName = (sheetApi as any).name || sheetApi.id;
    const spreadsheetId = await resolveSpreadsheetId(sheetApi, query);
    const sheetName = query.sheet;
    if (sheetName) {
      const values = await sheetsService.getRawValues(
        userId, spreadsheetId, sheetName, undefined, sheetApi.cacheTtlSeconds,
      );
      return buildEnvelope({
        apiId: sheetApi.id,
        apiName,
        sheets: [{ name: sheetName, rows: rowsFromValues(values) }],
      });
    }
    const allRaw = await sheetsService.getAllSheetsRaw(userId, spreadsheetId, sheetApi.cacheTtlSeconds);
    return buildEnvelope({
      apiId: sheetApi.id,
      apiName,
      sheets: Object.entries(allRaw).map(([name, values]) => ({
        name,
        rows: rowsFromValues(values),
      })),
    });
  }

  // GET /:apiId/report — aggregate statistics for a target adapter.
  // Today only `target=aprender_sistema` is supported; the param is required
  // so we never have to guess what shape to report on.
  // ?sheet=<name> scopes the report to a single tab (recommended for big
  // spreadsheets to keep request memory bounded).
  app.get('/:apiId/report', async (request) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);

    if (!query.target) {
      throw new AppError(400, 'TARGET_REQUIRED', `Missing target. Use ?target=${APRENDER_TARGET}.`);
    }
    if (query.target !== APRENDER_TARGET) {
      throw new AppError(400, 'UNSUPPORTED_TARGET', `Unsupported target: "${query.target}". Available: ${APRENDER_TARGET}.`);
    }

    const envelope = await buildTargetEnvelope(sheetApi, userId, query);
    return buildAprenderSistemaReport(buildAprenderSistemaTarget(envelope));
  });

  // GET /:apiId/export.csv — CSV projection of a target adapter, filtered by
  // ?type=<exportable target_type>. Reuses the existing adapter; no extra
  // transform logic lives here.
  // Body is streamed line-by-line so a million-row sheet won't materialise as
  // a single string in memory.
  // ?sheet=<name> scopes the export to a single tab (recommended for big
  // spreadsheets).
  app.get('/:apiId/export.csv', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);

    const validated = validateCsvExportQuery({ target: query.target, type: query.type });
    if (!validated.ok) {
      throw new AppError(400, validated.code, validated.message);
    }
    const exportType = validated.type;

    const envelope = await buildTargetEnvelope(sheetApi, userId, query);
    const target = buildAprenderSistemaTarget(envelope);

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${buildCsvFilename(exportType, sheetApi.id)}"`);
    return reply.send(streamTargetCsv(target, exportType));
  });

  // GET /:apiId/keys — return column names
  app.get('/:apiId/keys', async (request) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    return sheetsService.getColumnNames(userId, sheetApi.spreadsheetId, query.sheet, sheetApi.cacheTtlSeconds);
  });

  // GET /:apiId/count — return row count
  app.get('/:apiId/count', async (request) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    const rows = await sheetsService.getRowCount(userId, sheetApi.spreadsheetId, query.sheet);
    return { rows };
  });

  // GET /:apiId/search — AND search
  app.get('/:apiId/search', async (request) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    const sheetName = query.sheet;
    const caseSensitive = query.casesensitive === 'true';

    const spreadsheetId = await resolveSpreadsheetId(sheetApi, query);
    let rows = await sheetsService.getRows(userId, spreadsheetId, sheetName, sheetApi.cacheTtlSeconds);

    const filters = buildFilters(query, caseSensitive);
    rows = filterAnd(rows, filters);

    if (query.include_computed !== 'false') {
      const computedFields = await getComputedFieldsForApi(sheetApi.id);
      rows = applyComputedFields(rows, computedFields);
    }

    rows = applyPagination(rows, {
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
      sort_by: query.sort_by,
      sort_order: query.sort_order as 'asc' | 'desc' | 'random' | undefined,
      cast_numbers: query.cast_numbers === 'true',
    });

    if (query.cast_numbers === 'true') return castNumbers(rows);
    if (query.single_object === 'true' && rows.length > 0) return rows[0];
    return rows;
  });

  // GET /:apiId/search_or — OR search
  app.get('/:apiId/search_or', async (request) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    const sheetName = query.sheet;
    const caseSensitive = query.casesensitive === 'true';

    const spreadsheetId = await resolveSpreadsheetId(sheetApi, query);
    let rows = await sheetsService.getRows(userId, spreadsheetId, sheetName, sheetApi.cacheTtlSeconds);

    const filters = buildFilters(query, caseSensitive);
    rows = filterOr(rows, filters);

    if (query.include_computed !== 'false') {
      const computedFields = await getComputedFieldsForApi(sheetApi.id);
      rows = applyComputedFields(rows, computedFields);
    }

    rows = applyPagination(rows, {
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
      sort_by: query.sort_by,
      sort_order: query.sort_order as 'asc' | 'desc' | 'random' | undefined,
      cast_numbers: query.cast_numbers === 'true',
    });

    if (query.cast_numbers === 'true') return castNumbers(rows);
    if (query.single_object === 'true' && rows.length > 0) return rows[0];
    return rows;
  });

  // POST /:apiId/batch/update — batch update with filters
  app.post('/:apiId/batch/update', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    if (!sheetApi.allowUpdate) {
      return reply.status(403).send({ error: true, message: 'Updating disabled.', code: 'UPDATE_DISABLED', statusCode: 403 });
    }

    const body = request.body as { filters?: Record<string, string>; filter_mode?: string; data?: Record<string, string> };
    if (!body?.filters || !body?.data) {
      throw new ValidationError('Body must have "filters" and "data" objects.');
    }

    const caseSensitive = query.casesensitive === 'true';
    const rows = await sheetsService.getRows(userId, sheetApi.spreadsheetId, query.sheet, sheetApi.cacheTtlSeconds);

    const filterFns = buildFilters(body.filters, caseSensitive);
    const matching = body.filter_mode === 'or' ? filterOr(rows, filterFns) : filterAnd(rows, filterFns);

    if (matching.length === 0) return { updated: 0 };

    // Find a unique column to match each row (use first column as identifier)
    const allRows = await sheetsService.getRows(userId, sheetApi.spreadsheetId, query.sheet, 0);
    const headers = Object.keys(allRows[0] ?? {});
    const idCol = headers[0];
    if (!idCol) return { updated: 0 };

    let updated = 0;
    for (const row of matching) {
      const idVal = row[idCol];
      if (idVal) {
        if (query.sync === 'true') {
          updated += await sheetsService.updateRows(userId, sheetApi.spreadsheetId, idCol, idVal, body.data, query.sheet);
        } else {
          await enqueueWrite({ type: 'update', userId, spreadsheetId: sheetApi.spreadsheetId, sheetName: query.sheet, column: idCol, value: idVal, data: body.data });
          updated++;
        }
      }
    }

    if (query.sync === 'true') return { updated };
    return reply.status(202).send({ queued: true, matchedRows: updated });
  });

  // POST /:apiId/batch/delete — batch delete with filters
  app.post('/:apiId/batch/delete', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    if (!sheetApi.allowDelete) {
      return reply.status(403).send({ error: true, message: 'Deleting disabled.', code: 'DELETE_DISABLED', statusCode: 403 });
    }

    const body = request.body as { filters?: Record<string, string>; filter_mode?: string };
    if (!body?.filters) {
      throw new ValidationError('Body must have a "filters" object.');
    }

    const caseSensitive = query.casesensitive === 'true';
    const rows = await sheetsService.getRows(userId, sheetApi.spreadsheetId, query.sheet, sheetApi.cacheTtlSeconds);

    const filterFns = buildFilters(body.filters, caseSensitive);
    const matching = body.filter_mode === 'or' ? filterOr(rows, filterFns) : filterAnd(rows, filterFns);

    if (matching.length === 0) return { deleted: 0 };

    const headers = Object.keys(rows[0] ?? {});
    const idCol = headers[0];
    if (!idCol) return { deleted: 0 };

    let deleted = 0;
    for (const row of matching) {
      const idVal = row[idCol];
      if (idVal) {
        if (query.sync === 'true') {
          deleted += await sheetsService.deleteRows(userId, sheetApi.spreadsheetId, idCol, idVal, query.sheet);
        } else {
          await enqueueWrite({ type: 'delete', userId, spreadsheetId: sheetApi.spreadsheetId, sheetName: query.sheet, column: idCol, value: idVal });
          deleted++;
        }
      }
    }

    if (query.sync === 'true') return { deleted };
    return reply.status(202).send({ queued: true, matchedRows: deleted });
  });

  // POST /:apiId — create rows
  app.post('/:apiId', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    if (!sheetApi.allowCreate) {
      return reply.status(403).send({
        error: true,
        message: 'Creating rows is disabled for this API.',
        code: 'CREATE_DISABLED',
        statusCode: 403,
      });
    }

    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Request body must have a "data" field with an object or array of objects.');
    }

    const rows = Array.isArray(parsed.data.data)
      ? parsed.data.data
      : [parsed.data.data];

    // Sync mode: execute immediately
    if (query.sync === 'true') {
      const created = await sheetsService.appendRows(userId, sheetApi.spreadsheetId, rows, query.sheet);
      return reply.status(201).send({ created });
    }

    // Async mode: enqueue via BullMQ
    const jobId = await enqueueWrite({
      type: 'append',
      userId,
      spreadsheetId: sheetApi.spreadsheetId,
      sheetName: query.sheet,
      rows,
    });
    return reply.status(202).send({ queued: true, jobId });
  });

  // PATCH /:apiId/:column/:value — update rows matching condition
  app.patch('/:apiId/:column/:value', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    if (!sheetApi.allowUpdate) {
      return reply.status(403).send({
        error: true,
        message: 'Updating rows is disabled for this API.',
        code: 'UPDATE_DISABLED',
        statusCode: 403,
      });
    }

    const { column, value } = request.params as { column: string; value: string };
    const parsed = updateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Request body must have a "data" field with an object.');
    }

    if (query.sync === 'true') {
      const updated = await sheetsService.updateRows(userId, sheetApi.spreadsheetId, column, value, parsed.data.data, query.sheet);
      return { updated };
    }

    const jobId = await enqueueWrite({
      type: 'update',
      userId,
      spreadsheetId: sheetApi.spreadsheetId,
      sheetName: query.sheet,
      column,
      value,
      data: parsed.data.data,
    });
    return reply.status(202).send({ queued: true, jobId });
  });

  // DELETE /:apiId/:column/:value — delete rows matching condition
  app.delete('/:apiId/:column/:value', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    if (!sheetApi.allowDelete) {
      return reply.status(403).send({
        error: true,
        message: 'Deleting rows is disabled for this API.',
        code: 'DELETE_DISABLED',
        statusCode: 403,
      });
    }

    const { column, value } = request.params as { column: string; value: string };

    if (query.sync === 'true') {
      const deleted = await sheetsService.deleteRows(userId, sheetApi.spreadsheetId, column, value, query.sheet);
      return { deleted };
    }

    const jobId = await enqueueWrite({
      type: 'delete',
      userId,
      spreadsheetId: sheetApi.spreadsheetId,
      sheetName: query.sheet,
      column,
      value,
    });
    return reply.status(202).send({ queued: true, jobId });
  });

  // DELETE /:apiId/all — clear all data rows
  app.delete('/:apiId/all', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    if (!sheetApi.allowDelete) {
      return reply.status(403).send({
        error: true,
        message: 'Deleting rows is disabled for this API.',
        code: 'DELETE_DISABLED',
        statusCode: 403,
      });
    }

    if (query.sync === 'true') {
      const deleted = await sheetsService.clearAllRows(userId, sheetApi.spreadsheetId, query.sheet);
      return { deleted };
    }

    const jobId = await enqueueWrite({
      type: 'clear',
      userId,
      spreadsheetId: sheetApi.spreadsheetId,
      sheetName: query.sheet,
    });
    return reply.status(202).send({ queued: true, jobId });
  });
}
