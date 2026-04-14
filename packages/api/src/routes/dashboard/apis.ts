import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';
import * as sheetsService from '../../services/google-sheets.service.js';

const slugRegex = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

const createApiSchema = z.object({
  name: z.string().min(1),
  spreadsheetUrl: z.string().min(1),
  slug: z.string().regex(slugRegex, 'Slug must be 3-50 chars, lowercase, letters/numbers/hyphens').optional(),
});

const updateApiSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().regex(slugRegex, 'Slug must be 3-50 chars, lowercase, letters/numbers/hyphens').nullable().optional(),
  allowRead: z.boolean().optional(),
  allowCreate: z.boolean().optional(),
  allowUpdate: z.boolean().optional(),
  allowDelete: z.boolean().optional(),
  bearerToken: z.string().nullable().optional(),
  basicUser: z.string().nullable().optional(),
  basicPass: z.string().nullable().optional(),
  corsOrigins: z.string().nullable().optional(),
  ipWhitelist: z.string().nullable().optional(),
  rateLimitRpm: z.number().min(1).optional(),
  cacheTtlSeconds: z.number().min(0).optional(),
});

function getUserId(request: any): string {
  return (request.user as { sub: string }).sub;
}

function extractSpreadsheetId(urlOrId: string): string {
  const match = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : urlOrId;
}

export async function dashboardApiRoutes(app: FastifyInstance) {
  // All dashboard routes require JWT
  app.addHook('onRequest', jwtAuth);

  // GET /dashboard/apis — list user's APIs
  app.get('/', async (request) => {
    const userId = getUserId(request);
    const apis = await prisma.sheetApi.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        spreadsheetId: true,
        allowRead: true,
        allowCreate: true,
        allowUpdate: true,
        allowDelete: true,
        cacheTtlSeconds: true,
        rateLimitRpm: true,
        createdAt: true,
        _count: { select: { apiKeys: true, usageLogs: true } },
      },
    });
    return { apis };
  });

  // POST /dashboard/apis — create a new sheet API
  app.post('/', async (request, reply) => {
    const userId = getUserId(request);
    const parsed = createApiSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Provide "name" and "spreadsheetUrl".');
    }

    const spreadsheetId = extractSpreadsheetId(parsed.data.spreadsheetUrl);

    // Validate access by trying to read column names with user's Google token
    try {
      await sheetsService.getColumnNames(userId, spreadsheetId);
    } catch (err) {
      app.log.error({ err, spreadsheetId, userId }, 'Failed to access spreadsheet');
      return reply.status(400).send({
        error: true,
        message: `Could not access the spreadsheet: ${err instanceof Error ? err.message : 'Unknown error'}`,
        code: 'SHEET_ACCESS_ERROR',
        statusCode: 400,
      });
    }

    const sheetApi = await prisma.sheetApi.create({
      data: {
        name: parsed.data.name,
        spreadsheetId,
        slug: parsed.data.slug ?? null,
        userId,
      },
    });

    return reply.status(201).send({ api: sheetApi });
  });

  // GET /dashboard/apis/:id — get API details
  app.get('/:id', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const api = await prisma.sheetApi.findFirst({
      where: { id, userId },
      include: {
        apiKeys: {
          select: { id: true, key: true, label: true, active: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!api) throw new NotFoundError('API not found.');
    return { api };
  });

  // PATCH /dashboard/apis/:id — update API settings
  app.patch('/:id', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const parsed = updateApiSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid update data.');
    }

    const api = await prisma.sheetApi.update({
      where: { id },
      data: parsed.data,
    });

    return { api };
  });

  // DELETE /dashboard/apis/:id — delete an API
  app.delete('/:id', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    await prisma.sheetApi.delete({ where: { id } });
    return { deleted: true };
  });

  // POST /dashboard/apis/:id/rotate-token — rotate bearer token
  app.post('/:id/rotate-token', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const newToken = crypto.randomUUID();
    const api = await prisma.sheetApi.update({
      where: { id },
      data: {
        bearerTokenPrevious: existing.bearerToken,
        bearerToken: newToken,
        bearerTokenRotatedAt: new Date(),
      },
    });

    return {
      bearerToken: newToken,
      previousTokenValidUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour grace
    };
  });

  // POST /dashboard/apis/:id/generate-hmac — generate HMAC secret
  app.post('/:id/generate-hmac', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const hmacSecret = crypto.randomBytes(32).toString('hex');
    await prisma.sheetApi.update({
      where: { id },
      data: { hmacSecret, requireSigning: true },
    });

    return { hmacSecret, requireSigning: true };
  });

  // POST /dashboard/apis/:id/keys — create an API key
  app.post('/:id/keys', async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { label?: string; scopes?: string[] };
    const label = body.label;

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const apiKey = await prisma.apiKey.create({
      data: {
        sheetApiId: id,
        key: crypto.randomUUID(),
        label: label ?? null,
        scopes: body.scopes ?? ['sheets:read', 'sheets:write', 'sheets:delete'],
      },
    });

    return reply.status(201).send({ apiKey });
  });

  // DELETE /dashboard/apis/:id/keys/:keyId — revoke an API key
  app.delete('/:id/keys/:keyId', async (request) => {
    const userId = getUserId(request);
    const { id, keyId } = request.params as { id: string; keyId: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const key = await prisma.apiKey.findFirst({ where: { id: keyId, sheetApiId: id } });
    if (!key) throw new NotFoundError('API key not found.');

    await prisma.apiKey.delete({ where: { id: keyId } });
    return { deleted: true };
  });

  // GET /dashboard/apis/:id/usage — get usage stats
  app.get('/:id/usage', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const query = (request.query ?? {}) as { days?: string };
    const days = Number(query.days) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [total, recent] = await Promise.all([
      prisma.usageLog.count({ where: { sheetApiId: id } }),
      prisma.usageLog.findMany({
        where: { sheetApiId: id, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          method: true,
          path: true,
          statusCode: true,
          responseMs: true,
          ip: true,
          createdAt: true,
        },
      }),
    ]);

    return { total, days, recent };
  });
}
