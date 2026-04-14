import type { FastifyInstance } from 'fastify';
import { parse } from 'csv-parse/sync';
import { Parser as Json2CsvParser } from 'json2csv';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError, AppError } from '../../lib/errors.js';
import * as sheetsService from '../../services/google-sheets.service.js';
import { apiAuth } from '../../middleware/api-auth.js';
import { apiCors } from '../../middleware/cors.js';
import { apiIpWhitelist } from '../../middleware/ip-whitelist.js';
import { enqueueWrite } from '../../queues/sheets-write.queue.js';

function getSheetApi(request: any) {
  return request.sheetApi as {
    id: string;
    spreadsheetId: string;
    userId: string | null;
    slug: string | null;
    allowRead: boolean;
    allowCreate: boolean;
  };
}

function getUserId(request: any): string {
  const sheetApi = getSheetApi(request);
  if (!sheetApi.userId) throw new AppError(500, 'NO_OWNER', 'This API has no owner.');
  return sheetApi.userId;
}

export async function importExportRoutes(app: FastifyInstance) {
  // Register multipart support for this plugin scope
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: 10_485_760 }, // 10MB
  });

  // Resolve SheetApi
  app.addHook('onRequest', async (request) => {
    const { apiId } = request.params as { apiId?: string };
    if (!apiId) return;

    let sheetApi = await prisma.sheetApi.findUnique({ where: { id: apiId } });
    if (!sheetApi) {
      sheetApi = await prisma.sheetApi.findUnique({ where: { slug: apiId } });
    }
    if (!sheetApi) throw new NotFoundError('API not found.');
    (request as any).sheetApi = sheetApi;
  });

  app.addHook('onRequest', apiCors);
  app.addHook('onRequest', apiIpWhitelist);
  app.addHook('onRequest', apiAuth);

  // GET /:apiId/export — export data as CSV or JSON
  app.get('/:apiId/export', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    if (!sheetApi.allowRead) {
      return reply.status(403).send({ error: true, message: 'Read disabled.', code: 'READ_DISABLED', statusCode: 403 });
    }

    const userId = getUserId(request);
    const query = (request.query ?? {}) as Record<string, string>;
    const format = query.format || 'json';

    const rows = await sheetsService.getRows(userId, sheetApi.spreadsheetId, query.sheet);

    if (format === 'csv') {
      if (rows.length === 0) {
        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="${sheetApi.slug || sheetApi.id}.csv"`);
        return '';
      }
      const csvParser = new Json2CsvParser({ fields: Object.keys(rows[0]) });
      const csv = csvParser.parse(rows);
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="${sheetApi.slug || sheetApi.id}.csv"`);
      return csv;
    }

    // JSON download
    reply.header('Content-Type', 'application/json');
    reply.header('Content-Disposition', `attachment; filename="${sheetApi.slug || sheetApi.id}.json"`);
    return rows;
  });

  // POST /:apiId/import — import CSV or JSON data
  app.post('/:apiId/import', async (request, reply) => {
    const sheetApi = getSheetApi(request);
    if (!sheetApi.allowCreate) {
      return reply.status(403).send({ error: true, message: 'Create disabled.', code: 'CREATE_DISABLED', statusCode: 403 });
    }

    const userId = getUserId(request);
    const query = (request.query ?? {}) as Record<string, string>;

    const file = await request.file();
    if (!file) {
      throw new ValidationError('No file uploaded. Send a CSV or JSON file.');
    }

    const buffer = await file.toBuffer();
    const content = buffer.toString('utf-8');
    const filename = file.filename.toLowerCase();

    let rows: Record<string, string>[];

    if (filename.endsWith('.csv') || file.mimetype === 'text/csv') {
      // Parse CSV
      const records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, string>[];
      rows = records;
    } else if (filename.endsWith('.json') || file.mimetype === 'application/json') {
      // Parse JSON
      const parsed = JSON.parse(content);
      rows = Array.isArray(parsed) ? parsed : parsed.data ? parsed.data : [parsed];
      // Ensure all values are strings
      rows = rows.map((row) => {
        const stringRow: Record<string, string> = {};
        for (const [k, v] of Object.entries(row)) {
          stringRow[k] = String(v ?? '');
        }
        return stringRow;
      });
    } else {
      throw new ValidationError('Unsupported file format. Upload a .csv or .json file.');
    }

    if (rows.length === 0) {
      return reply.status(200).send({ imported: 0 });
    }

    if (rows.length > 10000) {
      throw new ValidationError('Maximum 10,000 rows per import.');
    }

    // Enqueue the write
    const jobId = await enqueueWrite({
      type: 'append',
      userId,
      spreadsheetId: sheetApi.spreadsheetId,
      sheetName: query.sheet,
      rows,
    });

    return reply.status(202).send({ queued: true, jobId, rows: rows.length });
  });
}
