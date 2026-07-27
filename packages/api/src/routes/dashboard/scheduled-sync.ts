import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
// Import DEFAULT, não nomeado. O `cron-parser@4` é CommonJS e termina com
// `module.exports = CronParser`, um objeto montado em runtime — o
// `cjs-module-lexer` do Node não consegue enumerar as propriedades, então
// `import { parseExpression } from 'cron-parser'` compila e passa no vitest
// (que usa o interop do Vite) e explode no boot em produção com
// "Named export 'parseExpression' not found". Já quebrou um deploy uma vez.
import cronParser from 'cron-parser';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';
import { dashboardRateLimitOptions } from '../../middleware/rate-limiter.js';
import { updateSyncSchedule, removeSyncSchedule } from '../../queues/scheduled-sync.queue.js';
import { invalidateSheetApiCache } from '../../services/sheet-api-cache.service.js';

// Valida a expressão com o MESMO parser que vai executá-la: o `cron-parser`,
// na versão que o BullMQ já fixa para agendar job repetível.
//
// Antes havia aqui uma regex escrita à mão, e ela tinha divergido da gramática
// real nas duas direções. Recusava passo, porque a classe `[0-9,\-/]` não
// contém `*` e a alternativa `\*` só casava com asterisco sozinho — ou seja,
// recusava `*/15 * * * *`, que era o exemplo citado na própria mensagem de
// erro. Com isso, nenhuma sincronização por intervalo podia ser salva. E na
// outra direção aceitava lixo (`- - - - -`, `99 99 99 99 99`), que só ia
// falhar lá na frente, dentro do worker, longe de quem digitou.
//
// Usar o parser de verdade elimina a possibilidade de a regra daqui divergir
// do que a fila aceita.
function cronValido(expressao: string): boolean {
  // O `cron-parser` também aceita 4 e 6 campos (6 = com segundos). Exigimos 5
  // porque é o formato que o dashboard documenta e o único que a UI monta;
  // aceitar 4 campos silenciosamente agendaria algo diferente do que a pessoa
  // leu na tela.
  if (expressao.trim().split(/\s+/).length !== 5) return false;

  try {
    cronParser.parseExpression(expressao);
    return true;
  } catch {
    return false;
  }
}

const updateSyncSchema = z.object({
  syncEnabled: z.boolean(),
  syncCron: z.string().refine(cronValido, 'Invalid cron expression (e.g., "*/15 * * * *")').nullable().optional(),
});

function getUserId(request: any): string {
  return (request.user as { sub: string }).sub;
}

export async function scheduledSyncRoutes(app: FastifyInstance) {
  app.register(import('@fastify/rate-limit'), dashboardRateLimitOptions() as any);
  app.addHook('onRequest', jwtAuth);

  // GET /dashboard/apis/:id/sync — get sync settings
  app.get('/:id/sync', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({
      where: { id, userId },
      select: { id: true, syncEnabled: true, syncCron: true },
    });
    if (!existing) throw new NotFoundError('API not found.');

    return { sync: existing };
  });

  // PATCH /dashboard/apis/:id/sync — update sync settings
  app.patch('/:id/sync', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const parsed = updateSyncSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid sync settings.');
    }

    const { syncEnabled, syncCron } = parsed.data;

    if (syncEnabled && !syncCron && !existing.syncCron) {
      throw new ValidationError('A cron expression is required to enable sync.');
    }

    const api = await prisma.sheetApi.update({
      where: { id },
      data: {
        syncEnabled,
        syncCron: syncCron !== undefined ? syncCron : undefined,
      },
    });

    await invalidateSheetApiCache(api);

    // Update or remove the repeatable job
    if (api.syncEnabled && api.syncCron) {
      await updateSyncSchedule(id, api.syncCron, userId, existing.spreadsheetId);
    } else {
      await removeSyncSchedule(id);
    }

    return { sync: { syncEnabled: api.syncEnabled, syncCron: api.syncCron } };
  });

  // POST /dashboard/apis/:id/sync/trigger — manually trigger a sync
  app.post('/:id/sync/trigger', async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    // Manually trigger cache invalidation = force re-fetch on next request
    const { invalidateCache } = await import('../../services/google-sheets.service.js');
    await invalidateCache(existing.spreadsheetId);

    return reply.status(200).send({ triggered: true, message: 'Cache invalidated. Next request will fetch fresh data.' });
  });
}
