import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';
import * as sheetsService from '../../services/google-sheets.service.js';

function getUserId(request: any): string {
  return (request.user as { sub: string }).sub;
}

export async function snapshotRoutes(app: FastifyInstance) {
  app.addHook('onRequest', jwtAuth);

  // POST /dashboard/apis/:id/snapshots — create a snapshot of current data
  app.post('/:id/snapshots', async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as { sheet?: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    // Get current data
    const [rows, headers] = await Promise.all([
      sheetsService.getRows(userId, existing.spreadsheetId, query.sheet, 0),
      sheetsService.getColumnNames(userId, existing.spreadsheetId, query.sheet, 0),
    ]);

    // Get next version number
    const lastSnapshot = await prisma.snapshot.findFirst({
      where: { sheetApiId: id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (lastSnapshot?.version ?? 0) + 1;

    const snapshot = await prisma.snapshot.create({
      data: {
        sheetApiId: id,
        version: nextVersion,
        data: rows as any,
        headers,
        rowCount: rows.length,
        sheetName: query.sheet ?? null,
      },
    });

    return reply.status(201).send({ snapshot });
  });

  // GET /dashboard/apis/:id/snapshots — list snapshots
  app.get('/:id/snapshots', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const snapshots = await prisma.snapshot.findMany({
      where: { sheetApiId: id },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        headers: true,
        rowCount: true,
        sheetName: true,
        createdAt: true,
      },
    });

    return { snapshots };
  });

  // GET /dashboard/apis/:id/snapshots/:version — get snapshot data
  app.get('/:id/snapshots/:version', async (request) => {
    const userId = getUserId(request);
    const { id, version } = request.params as { id: string; version: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const snapshot = await prisma.snapshot.findUnique({
      where: { sheetApiId_version: { sheetApiId: id, version: Number(version) } },
    });
    if (!snapshot) throw new NotFoundError('Snapshot not found.');

    return { snapshot };
  });

  // DELETE /dashboard/apis/:id/snapshots/:version — delete a snapshot
  app.delete('/:id/snapshots/:version', async (request) => {
    const userId = getUserId(request);
    const { id, version } = request.params as { id: string; version: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const snapshot = await prisma.snapshot.findUnique({
      where: { sheetApiId_version: { sheetApiId: id, version: Number(version) } },
    });
    if (!snapshot) throw new NotFoundError('Snapshot not found.');

    await prisma.snapshot.delete({ where: { id: snapshot.id } });
    return { deleted: true };
  });
}
