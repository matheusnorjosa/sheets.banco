import type { JobsOptions } from 'bullmq';

/**
 * Defaults applied to every BullMQ job we enqueue. Centralized so retry policy
 * doesn't drift across queues silently — each queue can override what it
 * actually needs (e.g. shorter delay for sheets-write, longer for webhooks
 * targeting flaky third parties).
 *
 * - `attempts: 5` — gives ~62s of backoff with the default 2s base (2s, 4s,
 *   8s, 16s, 32s). Past that, the failure is usually persistent, not transient.
 * - `removeOnComplete` retains the last N successful jobs for replay/audit
 *   debugging without unbounded growth.
 * - `removeOnFail` retains failed jobs longer so we can inspect them in
 *   BullBoard / queue inspectors before they're GC'd.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
};

/**
 * Build job options for a specific queue. Merges DEFAULT_JOB_OPTIONS with the
 * caller's overrides — overrides win. Use this in every queue's
 * `defaultJobOptions` so the audit story is "look at one place + the
 * documented overrides," not "grep every queue file."
 */
export function buildJobOptions(overrides: Partial<JobsOptions> = {}): JobsOptions {
  return { ...DEFAULT_JOB_OPTIONS, ...overrides };
}
