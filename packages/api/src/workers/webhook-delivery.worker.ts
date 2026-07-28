import { Worker, type Job } from 'bullmq';
import crypto from 'node:crypto';
import type { WebhookDeliveryJobData } from '../queues/webhook-delivery.queue.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { decryptIfEncrypted } from '../lib/secret-cipher.js';
import { conexaoRedisDe } from '../lib/redis-connection.js';

const log = logger.child({ component: 'worker:webhook-delivery' });

let worker: Worker<WebhookDeliveryJobData> | null = null;

async function processJob(job: Job<WebhookDeliveryJobData>): Promise<void> {
  const { subscriptionId, deliveryId, url, secret, event, payload } = job.data;

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  // The secret travels through Redis (BullMQ job payload). It's encrypted on
  // disk and stays encrypted in transit; decrypt only at sign time so
  // plaintext lives only in this worker's memory for the duration of the call.
  const secretPlain = decryptIfEncrypted(secret);
  const signature = crypto
    .createHmac('sha256', secretPlain)
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
        // O id da ENTREGA, não o do job. O `job.id` do BullMQ é sequencial e
        // reciclável entre limpezas da fila, então consumidor que usasse esse
        // header para idempotência podia deduplicar entregas distintas.
        'X-Webhook-Delivery-Id': deliveryId,
        'X-Webhook-Timestamp': String(timestamp),
        'X-Signature-256': `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });

    // Uma escrita só por tentativa. Antes, o `throw` abaixo caía no `catch`
    // do MESMO bloco, então uma resposta não-ok gerava dois updates: o
    // primeiro gravava 'failed' + responseCode e o segundo reescrevia para
    // 'pending'. O estado final era o mesmo, mas ao custo de duas idas ao
    // Postgres por entrega falhada — e lendo o código ninguém diria isso.
    const ultimaTentativa = job.attemptsMade + 1 >= 5;
    await prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, subscriptionId },
      data: {
        status: response.ok ? 'success' : ultimaTentativa ? 'failed' : 'pending',
        attempts: job.attemptsMade + 1,
        responseCode: response.status,
      },
    });

    if (!response.ok) {
      // `respostaNaoOk` marca que a linha JÁ foi atualizada: o catch abaixo
      // trata só falha ANTES de haver resposta (rede, DNS, timeout).
      throw Object.assign(new Error(`Webhook returned ${response.status}`), {
        respostaNaoOk: true,
      });
    }
  } catch (err) {
    // Resposta não-ok já teve a linha atualizada logo acima; repropaga sem
    // escrever de novo. O `finally` cuida do `clearTimeout` nos dois caminhos.
    if ((err as { respostaNaoOk?: boolean })?.respostaNaoOk) {
      throw err; // Let BullMQ handle retry
    }

    // Update delivery attempt count
    await prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, subscriptionId },
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
  worker = new Worker<WebhookDeliveryJobData>(
    'webhook-delivery',
    processJob,
    {
      connection: conexaoRedisDe(redisUrl),
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    if (job) {
      log.error(
        {
          jobId: job.id,
          subscriptionId: job.data.subscriptionId,
          event: job.data.event,
          attempt: job.attemptsMade,
          err: err.message,
        },
        'Delivery failed',
      );
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
