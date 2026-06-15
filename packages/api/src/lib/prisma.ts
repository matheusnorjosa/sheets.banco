import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * Single shared Prisma client. Logging is gated by `LOG_LEVEL` so that
 * production stays quiet while `debug` surfaces every query for triage.
 *
 * Prisma already retries connection establishment on cold start, but
 * mid-flight pool blips (e.g., Supabase pooler maintenance) bubble up as
 * P1001/P1017. Wrap critical reads with `withTransientRetry` when that pain
 * shows up in metrics.
 */
export const prisma = new PrismaClient({
  log:
    env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace'
      ? ['query', 'info', 'warn', 'error']
      : ['warn', 'error'],
  errorFormat: env.NODE_ENV === 'production' ? 'minimal' : 'colorless',
});

/**
 * Wrap a Prisma call so transient connection errors retry with exponential
 * backoff. Use sparingly — only for reads on the request path that we don't
 * want returning 503 during a brief pool blip.
 */
const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P1017']);

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 50 }: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as { code?: string })?.code;
      if (!code || !TRANSIENT_CODES.has(code)) throw err;
      if (i === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, baseMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}
