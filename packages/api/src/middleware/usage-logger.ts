import type { FastifyInstance } from 'fastify';
import { enqueueUsageLog } from '../services/usage.service.js';

/**
 * Logs every sheet API request asynchronously. Entries are buffered by
 * usage.service and flushed in batches — see that module for the window.
 */
export function registerUsageLogger(app: FastifyInstance) {
  app.addHook('onResponse', async (request, reply) => {
    const sheetApi = request.sheetApi;
    if (!sheetApi) return;

    enqueueUsageLog({
      sheetApiId: sheetApi.id,
      method: request.method,
      // So o caminho, sem a querystring. A API aceita filtro por querystring
      // (`?cpf=...`), e gravar a URL inteira colocava PII numa tabela de
      // telemetria que ninguem trata como PII — sem politica de retencao, de
      // acesso ou de export. O caminho basta para "qual rota foi chamada".
      path: request.url.split('?')[0] ?? request.url,
      statusCode: reply.statusCode,
      responseMs: Math.round(reply.elapsedTime),
      ip: request.ip,
    });
  });
}
