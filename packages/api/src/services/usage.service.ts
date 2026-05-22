import { prisma } from '../lib/prisma.js';

interface UsageEntry {
  sheetApiId: string;
  method: string;
  path: string;
  statusCode: number;
  responseMs: number;
  ip?: string | null;
}

// Window: 100 entries OR 30s, whichever first. Tuned wider than audit
// (50/2s) because telemetry tolerates more latency than the audit trail,
// and the longer interval lets Neon scale-to-zero between bursts —
// each delayed batch is one wake-up instead of one-per-request.
const BATCH_LIMIT = 100;
const FLUSH_INTERVAL_MS = 30_000;

const buffer: UsageEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

async function flush(): Promise<void> {
  if (buffer.length === 0) return;

  const batch = buffer.splice(0, buffer.length);

  try {
    await prisma.usageLog.createMany({
      data: batch.map((entry) => ({
        sheetApiId: entry.sheetApiId,
        method: entry.method,
        path: entry.path,
        statusCode: entry.statusCode,
        responseMs: entry.responseMs,
        ip: entry.ip ?? null,
      })),
    });
  } catch {
    // Silently fail — telemetry should not break the app
  }
}

/**
 * Buffer a usage-log entry. Flushed in batches of BATCH_LIMIT or every
 * FLUSH_INTERVAL_MS — whichever first. The point is to keep Neon asleep
 * between bursts instead of issuing one INSERT per request.
 */
export function enqueueUsageLog(entry: UsageEntry): void {
  buffer.push(entry);

  if (buffer.length >= BATCH_LIMIT) {
    flush();
    return;
  }

  if (!flushTimer) {
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  }
}

/**
 * Force flush remaining entries (call on shutdown). Stops the interval
 * so the process can exit cleanly.
 */
export async function flushUsageLog(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();
}

/**
 * Test-only: reset internal state between tests. Not exported on the
 * public surface elsewhere.
 */
export function __resetUsageLogForTests(): void {
  buffer.length = 0;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
