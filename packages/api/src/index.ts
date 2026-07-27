import { buildApp } from './app.js';
import { env } from './config/env.js';
import { initCache } from './services/cache.service.js';
import { initSheetsWriteQueue } from './queues/sheets-write.queue.js';
import { initSheetsWriteWorker, closeSheetsWriteWorker } from './workers/sheets-write.worker.js';
import { initWebhookDeliveryQueue } from './queues/webhook-delivery.queue.js';
import { initWebhookDeliveryWorker, closeWebhookDeliveryWorker } from './workers/webhook-delivery.worker.js';
import { initScheduledSyncQueue, updateSyncSchedule } from './queues/scheduled-sync.queue.js';
import { initScheduledSyncWorker, closeScheduledSyncWorker } from './workers/scheduled-sync.worker.js';
import { flushAuditLog } from './services/audit.service.js';
import { flushUsageLog } from './services/usage.service.js';
import { eagerLoadCipherKey } from './lib/secret-cipher.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

/**
 * Ponto de entrada: só boot. A montagem do Fastify (plugins, error handler e
 * rotas) vive em `app.ts`, que é importável sem efeito colateral — este
 * arquivo é o único que abre porta, conecta e inicia fila.
 *
 * Ele continua chamando `start()` na importação, então segue de fora da
 * checagem de import do CI (`scripts/verifica-imports.mjs`). O `app.ts`, que é
 * onde mora o grafo de imports que interessa, está coberto por ela.
 */
const start = async () => {
  try {
    // Falha alto no boot se a SECRETS_ENC_KEY for obrigatória e estiver
    // ausente/inválida, em vez de estourar na primeira rotação ou escrita
    // assinada.
    eagerLoadCipherKey();

    const app = await buildApp();

    app.addHook('onClose', async () => {
      await flushAuditLog();
      await flushUsageLog();
      await closeSheetsWriteWorker();
      await closeWebhookDeliveryWorker();
      await closeScheduledSyncWorker();
    });

    await app.ready();

    // O cache Redis só pode ser inicializado depois que o plugin registrou.
    initCache(app.redis);

    // O BullMQ exige um Redis de verdade. Sem ele (REDIS_URL não configurada),
    // escrita/webhook/sync ficam indisponíveis, mas a leitura continua rápida
    // em vez de queimar segundos por requisição tentando reconectar.
    const hasRedis = !!app.redis;
    if (hasRedis) {
      initSheetsWriteQueue(env.REDIS_URL);
      initSheetsWriteWorker(env.REDIS_URL);
      initWebhookDeliveryQueue(env.REDIS_URL);
      initWebhookDeliveryWorker(env.REDIS_URL);
      initScheduledSyncQueue(env.REDIS_URL);
      initScheduledSyncWorker(env.REDIS_URL);
      app.log.info('BullMQ queues and workers started');
    } else {
      app.log.warn('Skipping BullMQ initialization — Redis not configured (writes/webhooks/scheduled-sync disabled)');
    }

    // Restaura os agendamentos de sync a partir do banco
    const syncApis = await prisma.sheetApi.findMany({
      where: { syncEnabled: true, syncCron: { not: null } },
      select: { id: true, syncCron: true, userId: true, spreadsheetId: true },
    });
    for (const api of syncApis) {
      if (api.syncCron && api.userId) {
        await updateSyncSchedule(api.id, api.syncCron, api.userId, api.spreadsheetId);
      }
    }
    if (syncApis.length > 0) app.log.info(`Restored ${syncApis.length} scheduled sync jobs`);

    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`sheets.banco API running on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    // `logger` avulso, não `app.log`: se o `buildApp()` for quem falhou, `app`
    // é undefined e `app.log.fatal` estouraria um TypeError, mascarando o erro
    // de verdade justamente no momento em que ele mais importa.
    logger.fatal({ err }, 'Falha ao iniciar a API');
    process.exit(1);
  }
};

start();
