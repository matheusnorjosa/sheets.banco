import { Queue } from 'bullmq';
import { buildJobOptions } from '../lib/queue-options.js';
import { conexaoRedisDe } from '../lib/redis-connection.js';
import { comFilaDisponivel } from '../lib/queue-guard.js';

export interface SyncJobData {
  sheetApiId: string;
  userId: string;
  spreadsheetId: string;
}

let queue: Queue<SyncJobData> | null = null;

export function initScheduledSyncQueue(redisUrl: string): Queue<SyncJobData> {
  queue = new Queue<SyncJobData>('scheduled-sync', {
    connection: conexaoRedisDe(redisUrl),
    // Fewer attempts — sync is repeatable; the next cron fire will re-do the
    // invalidation anyway, so deep retry loops are wasteful.
    defaultJobOptions: buildJobOptions({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    }),
  });
  return queue;
}

export function getScheduledSyncQueue(): Queue<SyncJobData> {
  if (!queue) throw new Error('Scheduled sync queue not initialized');
  return queue;
}

/**
 * Identidade do agendamento de uma API. É a chave que o BullMQ usa para
 * reconhecer que um `upsert` é atualização e não um segundo agendamento —
 * derivar do `sheetApiId` garante um agendamento por API, sem varredura.
 */
function idDoAgendamento(sheetApiId: string): string {
  return `sync-${sheetApiId}`;
}

/**
 * Cria ou atualiza o agendamento de sincronização de uma API.
 *
 * O BullMQ 6 removeu os "repeatable jobs" e pôs Job Schedulers no lugar. A
 * troca encolheu esta função: o `upsertJobScheduler` já é idempotente, então o
 * remove-antes-de-adicionar que existia aqui deixou de ser necessário — e com
 * ele some a janela em que a API ficava sem agendamento nenhum entre as duas
 * chamadas.
 */
export async function updateSyncSchedule(
  sheetApiId: string,
  cronExpression: string,
  userId: string,
  spreadsheetId: string,
): Promise<void> {
  await comFilaDisponivel('scheduled-sync', async () => {
    const q = getScheduledSyncQueue();

    await q.upsertJobScheduler(
      idDoAgendamento(sheetApiId),
      { pattern: cronExpression },
      { name: 'sync', data: { sheetApiId, userId, spreadsheetId } },
    );
  });
}

/**
 * Remove o agendamento de sincronização de uma API.
 *
 * Antes era preciso listar todos os repeatable jobs e casar pela `key`; hoje a
 * remoção é direta pelo id do scheduler. Devolver `false` (não existia) não é
 * erro: remover agendamento ausente é no-op por design, porque quem chama
 * desliga o `syncEnabled` sem saber se havia agendamento.
 */
export async function removeSyncSchedule(sheetApiId: string): Promise<void> {
  await comFilaDisponivel('scheduled-sync', async () => {
    const q = getScheduledSyncQueue();
    await q.removeJobScheduler(idDoAgendamento(sheetApiId));
  });
}
