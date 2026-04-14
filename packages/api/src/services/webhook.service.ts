import { prisma } from '../lib/prisma.js';
import { enqueueWebhookDelivery } from '../queues/webhook-delivery.queue.js';

type WebhookEvent = 'row.created' | 'row.updated' | 'row.deleted' | 'rows.cleared';

/**
 * Dispatch webhook events for a SheetApi.
 * Finds active subscriptions matching the event and enqueues deliveries.
 */
export async function dispatchWebhooks(
  sheetApiId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const subscriptions = await prisma.webhookSubscription.findMany({
      where: {
        sheetApiId,
        active: true,
        events: { has: event },
      },
    });

    for (const sub of subscriptions) {
      // Create delivery record
      const delivery = await prisma.webhookDelivery.create({
        data: {
          subscriptionId: sub.id,
          event,
          payload: payload as any,
          status: 'pending',
        },
      });

      // Enqueue for async delivery
      await enqueueWebhookDelivery({
        subscriptionId: sub.id,
        url: sub.url,
        secret: sub.secret,
        event,
        payload,
      });
    }
  } catch {
    // Silently fail — webhooks should not break the main flow
  }
}
