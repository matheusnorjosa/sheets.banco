import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

/**
 * Logs every sheet API request asynchronously (fire-and-forget).
 */
export function registerUsageLogger(app: FastifyInstance) {
  app.addHook('onResponse', async (request, reply) => {
    const sheetApi = (request as any).sheetApi;
    if (!sheetApi) return;

    const responseMs = Math.round(reply.elapsedTime);

    // Fire and forget — don't block the response
    prisma.usageLog.create({
      data: {
        sheetApiId: sheetApi.id,
        method: request.method,
        path: request.url,
        statusCode: reply.statusCode,
        responseMs,
        ip: request.ip,
      },
    }).catch(() => {
      // Silently ignore logging errors
    });
  });
}
