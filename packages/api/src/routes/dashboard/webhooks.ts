import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';
import { dashboardRateLimitOptions } from '../../middleware/rate-limiter.js';
import { encrypt } from '../../lib/secret-cipher.js';
import { auditarRequisicao } from '../../services/audit.service.js';

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
  app.register(import('@fastify/rate-limit'), dashboardRateLimitOptions() as any);
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

    // Plaintext is returned once in this response (consumers use it to verify
    // signatures we send). DB stores the encrypted envelope. Rotation = delete
    // + create.
    const secretPlain = crypto.randomBytes(32).toString('hex');
    const webhook = await prisma.webhookSubscription.create({
      data: {
        sheetApiId: id,
        url: parsed.data.url,
        events: parsed.data.events,
        secret: encrypt(secretPlain),
      },
    });

    auditarRequisicao(request, {
      action: 'webhook.created',
      resourceType: 'WebhookSubscription',
      resourceId: webhook.id,
      sheetApiId: id,
      // URL e eventos entram na trilha; o segredo, nunca.
      changes: { url: { old: null, new: webhook.url }, events: { old: null, new: parsed.data.events } },
    });

    return reply.status(201).send({ webhook: { ...webhook, secret: secretPlain } });
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

    // `deleteMany` com o par (id, sheetApiId) em vez de `delete` por id: a
    // checagem acima prova que o usuário é dono da API `id`, mas NÃO que o
    // `webhookId` pertence a ela. Apagar só pelo id deixava qualquer dono de
    // qualquer API apagar webhook de outro usuário — o PATCH logo acima já
    // fazia a amarração certa. Como bônus, `deleteMany` devolve `count` em vez
    // de estourar P2025 (500) quando o registro não existe, então o "não
    // encontrado" vira 404 de verdade.
    const { count } = await prisma.webhookSubscription.deleteMany({
      where: { id: webhookId, sheetApiId: id },
    });
    if (count === 0) throw new NotFoundError('Webhook not found.');

    auditarRequisicao(request, {
      action: 'webhook.deleted',
      resourceType: 'WebhookSubscription',
      resourceId: webhookId,
      sheetApiId: id,
    });

    return { deleted: true };
  });

  // GET /dashboard/apis/:id/webhooks/:webhookId/deliveries — get delivery history
  app.get('/:id/webhooks/:webhookId/deliveries', async (request) => {
    const userId = getUserId(request);
    const { id, webhookId } = request.params as { id: string; webhookId: string };

    const api = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!api) throw new NotFoundError('API not found.');

    // Mesma amarração do PATCH e do DELETE: ser dono da API `id` não implica
    // que `webhookId` seja dela. Sem esta checagem, o histórico de entregas de
    // qualquer webhook vazava para quem soubesse o id — e o payload das
    // deliveries carrega os dados das linhas da planilha.
    const subscription = await prisma.webhookSubscription.findFirst({
      where: { id: webhookId, sheetApiId: id },
      select: { id: true },
    });
    if (!subscription) throw new NotFoundError('Webhook not found.');

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { subscriptionId: webhookId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return { deliveries };
  });
}
