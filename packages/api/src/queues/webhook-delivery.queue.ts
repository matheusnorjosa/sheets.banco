import { Queue } from 'bullmq';
import { buildJobOptions } from '../lib/queue-options.js';

export interface WebhookDeliveryJobData {
  subscriptionId: string;
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
}

let queue: Queue<WebhookDeliveryJobData> | null = null;

export function initWebhookDeliveryQueue(redisUrl: string): Queue<WebhookDeliveryJobData> {
  const url = new URL(redisUrl);
  queue = new Queue<WebhookDeliveryJobData>('webhook-delivery', {
    connection: {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password || undefined,
    },
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
