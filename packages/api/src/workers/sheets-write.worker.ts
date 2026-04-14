import { Worker, type Job } from 'bullmq';
import type { SheetWriteJobData, SheetWriteResult } from '../queues/sheets-write.queue.js';
import * as sheetsService from '../services/google-sheets.service.js';
import { dispatchWebhooks } from '../services/webhook.service.js';
import { prisma } from '../lib/prisma.js';

let worker: Worker<SheetWriteJobData, SheetWriteResult> | null = null;

async function resolveSheetApiId(spreadsheetId: string, userId: string): Promise<string | null> {
  const api = await prisma.sheetApi.findFirst({
    where: { spreadsheetId, userId },
    select: { id: true },
  });
  return api?.id ?? null;
}

async function processJob(job: Job<SheetWriteJobData, SheetWriteResult>): Promise<SheetWriteResult> {
  const { type, userId, spreadsheetId, sheetName } = job.data;
  let result: SheetWriteResult;

  switch (type) {
    case 'append': {
      const rows = job.data.rows;
      if (!rows || rows.length === 0) return { created: 0 };
      const created = await sheetsService.appendRows(userId, spreadsheetId, rows, sheetName);
      result = { created };
      break;
    }

    case 'update': {
      const { column, value, data } = job.data;
      if (!column || !value || !data) return { updated: 0 };
      const updated = await sheetsService.updateRows(userId, spreadsheetId, column, value, data, sheetName);
      result = { updated };
      break;
    }

    case 'delete': {
      const { column, value } = job.data;
      if (!column || !value) return { deleted: 0 };
      const deleted = await sheetsService.deleteRows(userId, spreadsheetId, column, value, sheetName);
      result = { deleted };
      break;
    }

    case 'clear': {
      const deleted = await sheetsService.clearAllRows(userId, spreadsheetId, sheetName);
      result = { deleted };
      break;
    }

    default:
      throw new Error(`Unknown job type: ${type}`);
  }

  // Dispatch webhooks after successful write
  const sheetApiId = await resolveSheetApiId(spreadsheetId, userId);
  if (sheetApiId) {
    const eventMap: Record<string, string> = {
      append: 'row.created',
      update: 'row.updated',
      delete: 'row.deleted',
      clear: 'rows.cleared',
    };
    dispatchWebhooks(sheetApiId, eventMap[type] as any, {
      type,
      spreadsheetId,
      sheetName: sheetName ?? null,
      result,
    }).catch(() => {}); // fire and forget
  }

  return result;
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
