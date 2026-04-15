import { Worker, type Job } from 'bullmq';
import type { SyncJobData } from '../queues/scheduled-sync.queue.js';
import { invalidateCache } from '../services/google-sheets.service.js';

let worker: Worker<SyncJobData> | null = null;

async function processSync(job: Job<SyncJobData>): Promise<void> {
  const { spreadsheetId, sheetApiId } = job.data;

  // Invalidate cache to force fresh fetch on next request
  await invalidateCache(spreadsheetId);

  console.log(`[scheduled-sync] Cache invalidated for API ${sheetApiId} (spreadsheet ${spreadsheetId})`);
}

export function initScheduledSyncWorker(redisUrl: string): Worker<SyncJobData> {
  const url = new URL(redisUrl);

  worker = new Worker<SyncJobData>(
    'scheduled-sync',
    processSync,
    {
      connection: {
        host: url.hostname,
        port: Number(url.port) || 6379,
        password: url.password || undefined,
      },
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    if (job) {
      console.log(`[scheduled-sync] Job ${job.id} completed`);
    }
  });

  worker.on('failed', (job, err) => {
    if (job) {
      console.error(`[scheduled-sync] Job ${job.id} failed:`, err.message);
    }
  });

  return worker;
}

export async function closeScheduledSyncWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
