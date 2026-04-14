import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';

const validEvents = ['row.created', 'row.updated', 'row.deleted', 'rows.cleared'];

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(['row.created', 'row.updated', 'row.deleted', 'rows.cleared'])).min(1),
});

const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum(['row.created', 'row.updated', 'row.deleted', 'rows.cleared'])).min(1).optional(),
  active: z.boolean().optional(),
});

function getUserId(request: any): string {
  return (request.user as { sub: string }).sub;
}

export async function webhookRoutes(app: FastifyInstance) {
  app.addHook('onRequest', jwtAuth);

  // GET /dashboard/apis/:id/webhooks — list webhooks
  app.get('/:id/webhooks', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const api = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!api) throw new NotFoundError('API not found.');

    const webhooks = await prisma.webhookSubscription.findMany({
      where: { sheetApiId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { deliveries: true } },
      },
    });

    return { webhooks };
  });

  // POST /dashboard/apis/:id/webhooks — create webhook
  app.post('/:id/webhooks', async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const api = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!api) throw new NotFoundError('API not found.');

    const parsed = createWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Provide a valid "url" and at least one "event".');
    }

    const webhook = await prisma.webhookSubscription.create({
      data: {
        sheetApiId: id,
        url: parsed.data.url,
        events: parsed.data.events,
        secret: crypto.randomBytes(32).toString('hex'),
      },
    });

    return reply.status(201).send({ webhook });
  });

  // PATCH /dashboard/apis/:id/webhooks/:webhookId — update webhook
  app.patch('/:id/webhooks/:webhookId', async (request) => {
    const userId = getUserId(request);
    const { id, webhookId } = request.params as { id: string; webhookId: string };

    const api = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!api) throw new NotFoundError('API not found.');

    const existing = await prisma.webhookSubscription.findFirst({ where: { id: webhookId, sheetApiId: id } });
    if (!existing) throw new NotFoundError('Webhook not found.');

    const parsed = updateWebhookSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid update data.');

    const webhook = await prisma.webhookSubscription.update({
      where: { id: webhookId },
      data: parsed.data,
    });

    return { webhook };
  });

  // DELETE /dashboard/apis/:id/webhooks/:webhookId — delete webhook
  app.delete('/:id/webhooks/:webhookId', async (request) => {
    const userId = getUserId(request);
    const { id, webhookId } = request.params as { id: string; webhookId: string };

    const api = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!api) throw new NotFoundError('API not found.');

    await prisma.webhookSubscription.delete({ where: { id: webhookId } });
    return { deleted: true };
  });

  // GET /dashboard/apis/:id/webhooks/:webhookId/deliveries — get delivery history
  app.get('/:id/webhooks/:webhookId/deliveries', async (request) => {
    const userId = getUserId(request);
    const { id, webhookId } = request.params as { id: string; webhookId: string };

    const api = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!api) throw new NotFoundError('API not found.');

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { subscriptionId: webhookId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return { deliveries };
  });
}
