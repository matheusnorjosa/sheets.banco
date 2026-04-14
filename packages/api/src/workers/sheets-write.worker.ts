import { Worker, type Job } from 'bullmq';
import type { SheetWriteJobData, SheetWriteResult } from '../queues/sheets-write.queue.js';
import * as sheetsService from '../services/google-sheets.service.js';

let worker: Worker<SheetWriteJobData, SheetWriteResult> | null = null;

async function processJob(job: Job<SheetWriteJobData, SheetWriteResult>): Promise<SheetWriteResult> {
  const { type, userId, spreadsheetId, sheetName } = job.data;

  switch (type) {
    case 'append': {
      const rows = job.data.rows;
      if (!rows || rows.length === 0) return { created: 0 };
      const created = await sheetsService.appendRows(userId, spreadsheetId, rows, sheetName);
      return { created };
    }

    case 'update': {
      const { column, value, data } = job.data;
      if (!column || !value || !data) return { updated: 0 };
      const updated = await sheetsService.updateRows(userId, spreadsheetId, column, value, data, sheetName);
      return { updated };
    }

    case 'delete': {
      const { column, value } = job.data;
      if (!column || !value) return { deleted: 0 };
      const deleted = await sheetsService.deleteRows(userId, spreadsheetId, column, value, sheetName);
      return { deleted };
    }

    case 'clear': {
      const deleted = await sheetsService.clearAllRows(userId, spreadsheetId, sheetName);
      return { deleted };
    }

    default:
      throw new Error(`Unknown job type: ${type}`);
  }
}

export function initSheetsWriteWorker(redisUrl: string): Worker<SheetWriteJobData, SheetWriteResult> {
  const url = new URL(redisUrl);

  worker = new Worker<SheetWriteJobData, SheetWriteResult>(
    'sheets-write',
    processJob,
    {
      connection: {
        host: url.hostname,
        port: Number(url.port) || 6379,
        password: url.password || undefined,
      },
      concurrency: 3, // max 3 concurrent writes (across different spreadsheets)
      limiter: {
        max: 4,       // max 4 jobs per second (Google Sheets quota: 300/min)
        duration: 1000,
      },
    },
  );

  worker.on('completed', (job) => {
    if (job) {
      console.log(`[sheets-write] Job ${job.id} completed:`, job.returnvalue);
    }
  });

  worker.on('failed', (job, err) => {
    if (job) {
      console.error(`[sheets-write] Job ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
    }
  });

  return worker;
}

export async function closeSheetsWriteWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
