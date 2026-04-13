import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import * as sheetsService from '../../services/google-sheets.service.js';

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
    const sheetApi = (request as any).sheetApi;
    return sheetsService.getRows(sheetApi.spreadsheetId);
  });

  // GET /:apiId/keys — return column names
  app.get('/:apiId/keys', async (request) => {
    const sheetApi = (request as any).sheetApi;
    return sheetsService.getColumnNames(sheetApi.spreadsheetId);
  });

  // GET /:apiId/count — return row count
  app.get('/:apiId/count', async (request) => {
    const sheetApi = (request as any).sheetApi;
    const rows = await sheetsService.getRowCount(sheetApi.spreadsheetId);
    return { rows };
  });
}
