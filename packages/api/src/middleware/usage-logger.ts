import type { FastifyInstance } from 'fastify';
import { enqueueUsageLog } from '../services/usage.service.js';

/**
 * Logs every sheet API request asynchronously. Entries are buffered by
 * usage.service and flushed in batches — see that module for the window.
 */
export function registerUsageLogger(app: FastifyInstance) {
  app.addHook('onResponse', async (request, reply) => {
    const sheetApi = (request as any).sheetApi;
    if (!sheetApi) return;

    enqueueUsageLog({
      sheetApiId: sheetApi.id,
      method: request.method,
      path: request.url,
      statusCode: reply.statusCode,
      responseMs: Math.round(reply.elapsedTime),
      ip: request.ip,
    });
  });
}
