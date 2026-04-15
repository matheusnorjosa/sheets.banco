import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';
import { updateSyncSchedule, removeSyncSchedule } from '../../queues/scheduled-sync.queue.js';

const cronRegex = /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/;

const updateSyncSchema = z.object({
  syncEnabled: z.boolean(),
  syncCron: z.string().regex(cronRegex, 'Invalid cron expression (e.g., "*/15 * * * *")').nullable().optional(),
});

function getUserId(request: any): string {
  return (request.user as { sub: string }).sub;
}

export async function scheduledSyncRoutes(app: FastifyInstance) {
  app.addHook('onRequest', jwtAuth);

  // GET /dashboard/apis/:id/sync — get sync settings
  app.get('/:id/sync', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({
      where: { id, userId },
      select: { id: true, syncEnabled: true, syncCron: true },
    });
    if (!existing) throw new NotFoundError('API not found.');

    return { sync: existing };
  });

  // PATCH /dashboard/apis/:id/sync — update sync settings
  app.patch('/:id/sync', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const parsed = updateSyncSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid sync settings.');
    }

    const { syncEnabled, syncCron } = parsed.data;

    if (syncEnabled && !syncCron && !existing.syncCron) {
      throw new ValidationError('A cron expression is required to enable sync.');
    }

    const api = await prisma.sheetApi.update({
      where: { id },
      data: {
        syncEnabled,
        syncCron: syncCron !== undefined ? syncCron : undefined,
      },
    });

    // Update or remove the repeatable job
    if (api.syncEnabled && api.syncCron) {
      await updateSyncSchedule(id, api.syncCron, userId, existing.spreadsheetId);
    } else {
      await removeSyncSchedule(id);
    }

    return { sync: { syncEnabled: api.syncEnabled, syncCron: api.syncCron } };
  });

  // POST /dashboard/apis/:id/sync/trigger — manually trigger a sync
  app.post('/:id/sync/trigger', async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    // Manually trigger cache invalidation = force re-fetch on next request
    const { invalidateCache } = await import('../../services/google-sheets.service.js');
    await invalidateCache(existing.spreadsheetId);

    return reply.status(200).send({ triggered: true, message: 'Cache invalidated. Next request will fetch fresh data.' });
  });
}
