import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
// Import NOMEADO — e o motivo de ter mudado importa, porque a regra aqui já
// foi a oposta.
//
// No `cron-parser@4` o pacote terminava com `module.exports = CronParser`, um
// objeto montado em runtime que o `cjs-module-lexer` do Node não consegue
// enumerar. Ali o named import compilava, passava no vitest (que usa o interop
// do Vite) e explodia no boot em produção com "Named export not found" — já
// derrubou um deploy uma vez. Por isso o import era default.
//
// A v5 continua sendo CommonJS (`type: commonjs`, sem campo `exports`), então
// o risco de interop NÃO sumiu com o major: ele mudou de lado. O que mudou é
// que o build da v5 declara `exports.CronExpressionParser` diretamente, o
// lexer enxerga, e o named import roda no Node de verdade — verificado, não
// deduzido. Quem protege isso no CI é `scripts/verifica-imports.mjs`: tsc e
// vitest passam nos dois casos, então nenhum dos dois serve de prova.
import { CronExpressionParser } from 'cron-parser';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';
import { dashboardRateLimitOptions } from '../../middleware/rate-limiter.js';
import { updateSyncSchedule, removeSyncSchedule } from '../../queues/scheduled-sync.queue.js';
import { invalidateSheetApiCache } from '../../services/sheet-api-cache.service.js';

// Valida a expressão com o MESMO parser que vai executá-la: o `cron-parser`,
// na versão que o BullMQ já usa para agendar (Job Scheduler).
//
// ⚠️ Esse "mesmo" depende de o npm deduplicar as duas dependências. Hoje
// dedupa: a API pede `cron-parser ^5.7.0` e o `bullmq@6` pede `^5.6.2`, então
// as duas resolvem para a MESMA instalação. Bumpar uma sem a outra pode
// separá-las — foi o que ia acontecer ao mergear o bump do cron-parser
// sozinho, com a API validando na v5 e a fila executando na v4. Se um dia
// `npm ls cron-parser` deixar de mostrar `deduped`, a garantia abaixo caiu.
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
    CronExpressionParser.parse(expressao);
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
  await app.register(import('@fastify/rate-limit'), dashboardRateLimitOptions() as any);
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
