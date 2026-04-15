import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';
import * as sheetsService from '../../services/google-sheets.service.js';

const addSheetSchema = z.object({
  spreadsheetUrl: z.string().min(1),
  label: z.string().min(1).max(100),
});

function getUserId(request: any): string {
  return (request.user as { sub: string }).sub;
}

function extractSpreadsheetId(urlOrId: string): string {
  const match = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : urlOrId;
}

export async function multiSpreadsheetRoutes(app: FastifyInstance) {
  app.addHook('onRequest', jwtAuth);

  // GET /dashboard/apis/:id/spreadsheets — list additional spreadsheets
  app.get('/:id/spreadsheets', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({
      where: { id, userId },
      select: { id: true, spreadsheetId: true, name: true },
    });
    if (!existing) throw new NotFoundError('API not found.');

    const additional = await prisma.additionalSheet.findMany({
      where: { sheetApiId: id },
      orderBy: { createdAt: 'asc' },
    });

    return {
      primary: { spreadsheetId: existing.spreadsheetId, label: existing.name },
      additional,
    };
  });

  // POST /dashboard/apis/:id/spreadsheets — add an additional spreadsheet
  app.post('/:id/spreadsheets', async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const parsed = addSheetSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Provide "spreadsheetUrl" and "label".');
    }

    const spreadsheetId = extractSpreadsheetId(parsed.data.spreadsheetUrl);

    // Validate access
    try {
      await sheetsService.getColumnNames(userId, spreadsheetId);
    } catch {
      throw new ValidationError('Could not access the spreadsheet. Make sure it is shared with your Google account.');
    }

    // Check for duplicate
    const duplicate = await prisma.additionalSheet.findUnique({
      where: { sheetApiId_spreadsheetId: { sheetApiId: id, spreadsheetId } },
    });
    if (duplicate) {
      throw new ValidationError('This spreadsheet is already linked to this API.');
    }

    const sheet = await prisma.additionalSheet.create({
      data: {
        sheetApiId: id,
        spreadsheetId,
        label: parsed.data.label,
      },
    });

    return reply.status(201).send({ sheet });
  });

  // DELETE /dashboard/apis/:id/spreadsheets/:sheetId — remove an additional spreadsheet
  app.delete('/:id/spreadsheets/:sheetId', async (request) => {
    const userId = getUserId(request);
    const { id, sheetId } = request.params as { id: string; sheetId: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const sheet = await prisma.additionalSheet.findFirst({
      where: { id: sheetId, sheetApiId: id },
    });
    if (!sheet) throw new NotFoundError('Additional spreadsheet not found.');

    await prisma.additionalSheet.delete({ where: { id: sheetId } });
    return { deleted: true };
  });
}
