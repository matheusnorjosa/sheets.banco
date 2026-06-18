import { Worker, type Job } from 'bullmq';
import type { SyncJobData } from '../queues/scheduled-sync.queue.js';
import { invalidateCache } from '../services/google-sheets.service.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ component: 'worker:scheduled-sync' });

let worker: Worker<SyncJobData> | null = null;

async function processSync(job: Job<SyncJobData>): Promise<void> {
  const { spreadsheetId, sheetApiId } = job.data;

  await invalidateCache(spreadsheetId);

  log.info({ sheetApiId, spreadsheetId, jobId: job.id }, 'Cache invalidated');
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
      log.info({ jobId: job.id, sheetApiId: job.data.sheetApiId }, 'Job completed');
    }
  });

  worker.on('failed', (job, err) => {
    if (job) {
      log.error(
        { jobId: job.id, sheetApiId: job.data?.sheetApiId, attempt: job.attemptsMade, err: err.message },
        'Job failed',
      );
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
