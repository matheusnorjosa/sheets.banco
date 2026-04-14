import { Worker, type Job } from 'bullmq';
import crypto from 'node:crypto';
import type { WebhookDeliveryJobData } from '../queues/webhook-delivery.queue.js';
import { prisma } from '../lib/prisma.js';

let worker: Worker<WebhookDeliveryJobData> | null = null;

async function processJob(job: Job<WebhookDeliveryJobData>): Promise<void> {
  const { subscriptionId, url, secret, event, payload } = job.data;

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event': event,
        'X-Webhook-Delivery-Id': job.id ?? '',
        'X-Webhook-Timestamp': String(timestamp),
        'X-Signature-256': `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });

    // Update delivery record
    await prisma.webhookDelivery.updateMany({
      where: { subscriptionId, id: job.id ?? undefined },
      data: {
        status: response.ok ? 'success' : 'failed',
        attempts: job.attemptsMade + 1,
        responseCode: response.status,
      },
    });

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`);
    }
  } catch (err) {
    // Update delivery attempt count
    await prisma.webhookDelivery.updateMany({
      where: { subscriptionId, id: job.id ?? undefined },
      data: {
        status: job.attemptsMade + 1 >= 5 ? 'failed' : 'pending',
        attempts: job.attemptsMade + 1,
      },
    }).catch(() => {});

    throw err; // Let BullMQ handle retry
  } finally {
    clearTimeout(timeout);
  }
}

export function initWebhookDeliveryWorker(redisUrl: string): Worker<WebhookDeliveryJobData> {
  const url = new URL(redisUrl);
  worker = new Worker<WebhookDeliveryJobData>(
    'webhook-delivery',
    processJob,
    {
      connection: {
        host: url.hostname,
        port: Number(url.port) || 6379,
        password: url.password || undefined,
      },
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    if (job) {
      console.error(`[webhook] Delivery ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
    }
  });

  return worker;
}

export async function closeWebhookDeliveryWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
