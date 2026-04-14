import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError, AppError } from '../../lib/errors.js';
import * as sheetsService from '../../services/google-sheets.service.js';
import { buildFilters, filterAnd, filterOr } from '../../utils/query-parser.js';
import { applyPagination, castNumbers } from '../../utils/pagination.js';
import { apiAuth } from '../../middleware/api-auth.js';
import { apiCors } from '../../middleware/cors.js';
import { apiIpWhitelist } from '../../middleware/ip-whitelist.js';
import { apiRateLimitOptions } from '../../middleware/rate-limiter.js';
import { enqueueWrite } from '../../queues/sheets-write.queue.js';

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
  spreadsheetId: string;
  userId: string | null;
  cacheTtlSeconds: number;
  allowRead: boolean;
  allowCreate: boolean;
  allowUpdate: boolean;
  allowDelete: boolean;
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

export async function sheetsRoutes(app: FastifyInstance) {
  // Apply per-API rate limiting
  app.register(import('@fastify/rate-limit'), apiRateLimitOptions() as any);

  // Resolve SheetApi from :apiId param (supports both ID and slug)
  app.addHook('onRequest', async (request, reply) => {
    const { apiId } = request.params as { apiId?: string };
    if (!apiId) return;

    // Try by ID first, then by slug
    let sheetApi = await prisma.sheetApi.findUnique({ where: { id: apiId } });
    if (!sheetApi) {
      sheetApi = await prisma.sheetApi.findUnique({ where: { slug: apiId } });
    }

    if (!sheetApi) {
      throw new NotFoundError('API not found. Check your API ID or slug.');
    }

    (request as any).sheetApi = sheetApi;
  });

  // Per-API security: CORS, IP whitelist, auth
  app.addHook('onRequest', apiCors);
  app.addHook('onRequest', apiIpWhitelist);
  app.addHook('onRequest', apiAuth);

  // GET /:apiId — return all rows (with pagination)
  app.get('/:apiId', async (request) => {
    const sheetApi = getSheetApi(request);
    const userId = getUserId(request);
    const query = getQueryParams(request);
    const sheetName = query.sheet;

    let rows = await sheetsService.getRows(userId, sheetApi.spreadsheetId, sheetName, sheetApi.cacheTtlSeconds);

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

    let rows = await sheetsService.getRows(userId, sheetApi.spreadsheetId, sheetName, sheetApi.cacheTtlSeconds);

    const filters = buildFilters(query, caseSensitive);
    rows = filterAnd(rows, filters);

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

    let rows = await sheetsService.getRows(userId, sheetApi.spreadsheetId, sheetName, sheetApi.cacheTtlSeconds);

    const filters = buildFilters(query, caseSensitive);
    rows = filterOr(rows, filters);

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
