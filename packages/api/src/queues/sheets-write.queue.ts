import { Queue } from 'bullmq';
import type { SheetRow } from '../services/google-sheets.service.js';

export interface SheetWriteJobData {
  type: 'append' | 'update' | 'delete' | 'clear';
  userId: string;
  spreadsheetId: string;
  sheetName?: string;
  // For append
  rows?: SheetRow[];
  // For update
  column?: string;
  value?: string;
  data?: SheetRow;
}

export interface SheetWriteResult {
  created?: number;
  updated?: number;
  deleted?: number;
}

let queue: Queue<SheetWriteJobData, SheetWriteResult> | null = null;

export function initSheetsWriteQueue(redisUrl: string): Queue<SheetWriteJobData, SheetWriteResult> {
  const url = new URL(redisUrl);
  queue = new Queue<SheetWriteJobData, SheetWriteResult>('sheets-write', {
    connection: {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password || undefined,
    },
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000, // 2s, 4s, 8s, 16s, 32s
      },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
  return queue;
}

export function getSheetsWriteQueue(): Queue<SheetWriteJobData, SheetWriteResult> {
  if (!queue) throw new Error('Sheets write queue not initialized');
  return queue;
}

/**
 * Add a write job to the queue.
 * Returns the job ID for tracking.
 */
export async function enqueueWrite(data: SheetWriteJobData): Promise<string> {
  const q = getSheetsWriteQueue();
  const job = await q.add(data.type, data, {
    // Group by spreadsheetId to prevent concurrent writes to the same sheet
    jobId: `${data.type}-${data.spreadsheetId}-${Date.now()}`,
  });
  return job.id ?? 'unknown';
}
