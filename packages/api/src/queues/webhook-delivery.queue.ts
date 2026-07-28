import { Queue } from 'bullmq';
import { buildJobOptions } from '../lib/queue-options.js';
import { conexaoRedisDe } from '../lib/redis-connection.js';

export interface WebhookDeliveryJobData {
  subscriptionId: string;
  /**
   * Id da linha em `WebhookDelivery` que este job atualiza.
   *
   * Precisa viajar no payload porque o `job.id` do BullMQ é um contador da
   * fila ('1', '2', '3'…) e o id da entrega é um cuid do Prisma. O worker
   * antes atualizava por `job.id` e não casava com linha nenhuma, então toda
   * entrega ficava 'pending' para sempre no histórico do dashboard — inclusive
   * as entregues com 200.
   */
  deliveryId: string;
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
}

let queue: Queue<WebhookDeliveryJobData> | null = null;

export function initWebhookDeliveryQueue(redisUrl: string): Queue<WebhookDeliveryJobData> {
  queue = new Queue<WebhookDeliveryJobData>('webhook-delivery', {
    connection: conexaoRedisDe(redisUrl),
    // Longer backoff (10s base → ~310s total) — third-party webhook targets
    // are commonly down for >1min during their own incidents; aggressive
    // retries just amplify the spike.
    defaultJobOptions: buildJobOptions({
      backoff: { type: 'exponential', delay: 10000 },
      removeOnFail: { count: 2000 },
    }),
  });
  return queue;
}

export function getWebhookDeliveryQueue(): Queue<WebhookDeliveryJobData> {
  if (!queue) throw new Error('Webhook delivery queue not initialized');
  return queue;
}

export async function enqueueWebhookDelivery(data: WebhookDeliveryJobData): Promise<void> {
  const q = getWebhookDeliveryQueue();
  await q.add(data.event, data);
}
