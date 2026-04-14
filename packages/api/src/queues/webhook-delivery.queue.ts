import { Queue } from 'bullmq';

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
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 10000, // 10s, 20s, 40s, 80s, 160s
      },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2000 },
    },
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
