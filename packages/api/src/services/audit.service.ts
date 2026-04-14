import { prisma } from '../lib/prisma.js';

interface AuditEntry {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  sheetApiId?: string;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  ip?: string;
  userAgent?: string;
}

const buffer: AuditEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

async function flush(): Promise<void> {
  if (buffer.length === 0) return;

  const batch = buffer.splice(0, buffer.length);

  try {
    await prisma.auditLog.createMany({
      data: batch.map((entry) => ({
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        sheetApiId: entry.sheetApiId ?? null,
        changes: entry.changes as any ?? undefined,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      })),
    });
  } catch {
    // Silently fail — audit logging should not break the app
  }
}

/**
 * Log an audit event. Buffered and flushed every 2 seconds or at 50 entries.
 */
export function audit(entry: AuditEntry): void {
  buffer.push(entry);

  if (buffer.length >= 50) {
    flush();
  }

  if (!flushTimer) {
    flushTimer = setInterval(() => {
      flush();
    }, 2000);
  }
}

/**
 * Force flush remaining entries (call on shutdown).
 */
export async function flushAuditLog(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();
}
