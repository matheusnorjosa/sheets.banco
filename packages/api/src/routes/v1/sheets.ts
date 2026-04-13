import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import * as sheetsService from '../../services/google-sheets.service.js';

const createBodySchema = z.object({
  data: z.union([
    z.record(z.string(), z.string()),
    z.array(z.record(z.string(), z.string())),
  ]),
});

const updateBodySchema = z.object({
  data: z.record(z.string(), z.string()),
});

function getSheetApi(request: any) {
  return request.sheetApi as { spreadsheetId: string; allowRead: boolean; allowCreate: boolean; allowUpdate: boolean; allowDelete: boolean };
}

export async function sheetsRoutes(app: FastifyInstance) {
  // Resolve SheetApi from :apiId param
  app.addHook('onRequest', async (request, reply) => {
    const { apiId } = request.params as { apiId?: string };
    if (!apiId) return;

    const sheetApi = await prisma.sheetApi.findUnique({
      where: { id: apiId },
    });

    if (!sheetApi) {
      throw new NotFoundError('API not found. Check your API ID.');
    }

    (request as any).sheetApi = sheetApi;
  });

  // GET /:apiId — return all rows
  app.get('/:apiId', async (request) => {
    const sheetApi = getSheetApi(request);
    return sheetsService.getRows(sheetApi.spreadsheetId);
  });

  // GET /:apiId/keys — return column names
  app.get('/:apiId/keys', async (request) => {
    const sheetApi = getSheetApi(request);
    return sheetsService.getColumnNames(sheetApi.spreadsheetId);
  });

  // GET /:apiId/count — return row count
  app.get('/:apiId/count', async (request) => {
    const sheetApi = getSheetApi(request);
    const rows = await sheetsService.getRowCount(sheetApi.spreadsheetId);
    return { rows };
  });

  // POST /:apiId — create rows
  app.post('/:apiId', async (request, reply) => {
    const sheetApi = getSheetApi(request);
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

    const created = await sheetsService.appendRows(sheetApi.spreadsheetId, rows);
    return reply.status(201).send({ created });
  });

  // PATCH /:apiId/:column/:value — update rows matching condition
  app.patch('/:apiId/:column/:value', async (request, reply) => {
    const sheetApi = getSheetApi(request);
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

    const updated = await sheetsService.updateRows(
      sheetApi.spreadsheetId,
      column,
      value,
      parsed.data.data,
    );
    return { updated };
  });

  // DELETE /:apiId/:column/:value — delete rows matching condition
  app.delete('/:apiId/:column/:value', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    if (!sheetApi.allowDelete) {
      return reply.status(403).send({
        error: true,
        message: 'Deleting rows is disabled for this API.',
        code: 'DELETE_DISABLED',
        statusCode: 403,
      });
    }

    const { column, value } = request.params as { column: string; value: string };
    const deleted = await sheetsService.deleteRows(
      sheetApi.spreadsheetId,
      column,
      value,
    );
    return { deleted };
  });

  // DELETE /:apiId/all — clear all data rows
  app.delete('/:apiId/all', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    if (!sheetApi.allowDelete) {
      return reply.status(403).send({
        error: true,
        message: 'Deleting rows is disabled for this API.',
        code: 'DELETE_DISABLED',
        statusCode: 403,
      });
    }

    const deleted = await sheetsService.clearAllRows(sheetApi.spreadsheetId);
    return { deleted };
  });
}
