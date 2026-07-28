import { Queue } from 'bullmq';
import { buildJobOptions } from '../lib/queue-options.js';
import { conexaoRedisDe } from '../lib/redis-connection.js';

export interface SyncJobData {
  sheetApiId: string;
  userId: string;
  spreadsheetId: string;
}

let queue: Queue<SyncJobData> | null = null;

export function initScheduledSyncQueue(redisUrl: string): Queue<SyncJobData> {
  queue = new Queue<SyncJobData>('scheduled-sync', {
    connection: conexaoRedisDe(redisUrl),
    // Fewer attempts — sync is repeatable; the next cron fire will re-do the
    // invalidation anyway, so deep retry loops are wasteful.
    defaultJobOptions: buildJobOptions({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    }),
  });
  return queue;
}

export function getScheduledSyncQueue(): Queue<SyncJobData> {
  if (!queue) throw new Error('Scheduled sync queue not initialized');
  return queue;
}

/**
 * Add or update a repeatable sync job for an API.
 */
export async function updateSyncSchedule(
  sheetApiId: string,
  cronExpression: string,
  userId: string,
  spreadsheetId: string,
): Promise<void> {
  const q = getScheduledSyncQueue();

  // Remove existing repeatable job first
  await removeSyncSchedule(sheetApiId);

  // Add new repeatable job
  await q.add(
    'sync',
    { sheetApiId, userId, spreadsheetId },
    {
      repeat: { pattern: cronExpression },
      jobId: `sync-${sheetApiId}`,
    },
  );
}

/**
 * Remove a repeatable sync job for an API.
 */
export async function removeSyncSchedule(sheetApiId: string): Promise<void> {
  const q = getScheduledSyncQueue();
  const repeatableJobs = await q.getRepeatableJobs();
  for (const job of repeatableJobs) {
    if (job.id === `sync-${sheetApiId}`) {
      await q.removeRepeatableByKey(job.key);
    }
  }
}
