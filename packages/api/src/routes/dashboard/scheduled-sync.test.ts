/**
 * Testes de caracterização de `routes/dashboard/scheduled-sync.ts`.
 *
 * Por que este arquivo merece teste: é a única rota que escreve no agendador
 * (BullMQ repeatable job). Um erro aqui não dá 500 visível — dá planilha que
 * para de sincronizar em silêncio, ou job repetível órfão rodando para sempre
 * contra a cota do Google. Três invariantes valem trava:
 *
 *   1. **Posse.** As três rotas filtram por `{ id, userId }`; sem isso qualquer
 *      usuário logado mexeria no agendamento da API de outro.
 *   2. **Espelho fila ↔ banco.** Ligado com cron → `updateSyncSchedule`;
 *      qualquer outro estado → `removeSyncSchedule`. Nunca os dois.
 *   3. **Invalidação do cache.** O registro da SheetApi fica em cache Redis com
 *      TTL de 300s (`sheet-api-cache.service`). Sem `invalidateSheetApiCache`
 *      depois do update, a mudança de agendamento levaria até 5 minutos para
 *      valer no caminho de request — e o usuário veria a UI dizendo uma coisa e
 *      a API se comportando de outra.
 *
 * Prisma, a fila, o cache e o serviço do Google são mockados: o alvo é a lógica
 * da rota, não a infraestrutura.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const sheetApiDb = { findFirst: vi.fn(), update: vi.fn() };

vi.mock('../../lib/prisma.js', () => ({
  prisma: { sheetApi: sheetApiDb },
}));

const fila = {
  updateSyncSchedule: vi.fn().mockResolvedValue(undefined),
  removeSyncSchedule: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../../queues/scheduled-sync.queue.js', () => fila);

vi.mock('../../services/sheet-api-cache.service.js', () => ({
  invalidateSheetApiCache: vi.fn().mockResolvedValue(undefined),
  findSheetApiCached: vi.fn(),
}));

// A rota de trigger importa este módulo com `await import(...)` dinâmico —
// `vi.mock` intercepta do mesmo jeito que um import estático.
const sheetsService = { invalidateCache: vi.fn().mockResolvedValue(undefined) };
vi.mock('../../services/google-sheets.service.js', () => sheetsService);

vi.mock('../../config/env.js', () => ({
  env: { RATE_LIMIT_DASHBOARD_MAX: 1000, RATE_LIMIT_DASHBOARD_WINDOW: '1 minute' },
}));

// jwtAuth real exigiria montar o plugin inteiro; aqui só precisamos que
// `request.user.sub` exista, que é o que as rotas consomem.
vi.mock('../../middleware/jwt-auth.js', () => ({
  jwtAuth: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' };
  },
}));

const { montarApp, argDaChamada } = await import('../../test-utils/app.js');
const { invalidateSheetApiCache } = await import('../../services/sheet-api-cache.service.js');
const { scheduledSyncRoutes } = await import('./scheduled-sync.js');

let app: FastifyInstance;

const API = {
  id: 'api-1',
  slug: 'minha-api',
  userId: 'user-1',
  spreadsheetId: 'planilha-abc',
  syncEnabled: false,
  syncCron: null as string | null,
};

/** Tipagem mínima do `data` que a rota manda pro Prisma. */
interface DadosUpdate {
  where: { id: string };
  data: { syncEnabled: boolean; syncCron?: string | null };
}

/** Registro "no banco" da rodada. `null` = API inexistente ou de outro dono. */
let registro: typeof API | null;

/** Ajusta o registro do banco para o cenário do teste. */
function comRegistro(parcial: Partial<typeof API>) {
  registro = { ...API, ...parcial };
}

beforeEach(async () => {
  vi.clearAllMocks();
  registro = { ...API };
  sheetApiDb.findFirst.mockImplementation(async () => registro);
  // Espelha o Prisma: o registro devolvido é o anterior com o `data` aplicado.
  sheetApiDb.update.mockImplementation(async ({ data }: DadosUpdate) => ({
    ...(registro ?? API),
    ...data,
    // `undefined` no Prisma significa "não mexe"; o mock precisa imitar isso,
    // senão apagaria o cron ao invés de preservá-lo.
    syncCron: data.syncCron !== undefined ? data.syncCron : (registro ?? API).syncCron,
  }));
  app = await montarApp({ rotas: scheduledSyncRoutes, prefixo: '/dashboard/apis' });
});

describe('posse — API de outro dono some para o requisitante', () => {
  beforeEach(() => {
    registro = null;
  });

  it('GET /:id/sync dá 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-de-outro/sync' });
    expect(r.statusCode).toBe(404);
  });

  it('PATCH /:id/sync dá 404 e não toca no banco nem na fila', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-de-outro/sync',
      payload: { syncEnabled: true, syncCron: '0 3 * * *' },
    });

    expect(r.statusCode).toBe(404);
    expect(sheetApiDb.update).not.toHaveBeenCalled();
    expect(fila.updateSyncSchedule).not.toHaveBeenCalled();
    expect(fila.removeSyncSchedule).not.toHaveBeenCalled();
  });

  it('POST /:id/sync/trigger dá 404 e não invalida cache de planilha alheia', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-de-outro/sync/trigger' });

    expect(r.statusCode).toBe(404);
    expect(sheetsService.invalidateCache).not.toHaveBeenCalled();
  });

  it('a consulta de posse filtra por id E userId', async () => {
    await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/sync' });
    const consulta = argDaChamada<{ where: { id: string; userId: string } }>(sheetApiDb.findFirst);
    expect(consulta.where).toEqual({ id: 'api-1', userId: 'user-1' });
  });
});

describe('GET /dashboard/apis/:id/sync', () => {
  it('devolve só id, syncEnabled e syncCron', async () => {
    sheetApiDb.findFirst.mockResolvedValue({ id: 'api-1', syncEnabled: true, syncCron: '0 3 * * *' });

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/sync' });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ sync: { id: 'api-1', syncEnabled: true, syncCron: '0 3 * * *' } });
  });

  it('o select limita as colunas — é ele que impede vazar segredo da SheetApi', async () => {
    await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/sync' });

    const consulta = argDaChamada<{ select: Record<string, unknown> }>(sheetApiDb.findFirst);
    expect(consulta.select).toEqual({ id: true, syncEnabled: true, syncCron: true });
  });
});

describe('PATCH /:id/sync — validação do cron', () => {
  it.each([
    ['passo — o exemplo da própria mensagem de erro', '*/15 * * * *'],
    ['passo de 5 em 5 minutos', '*/5 * * * *'],
    ['passo na hora', '0 */2 * * *'],
    ['todo dia às 3h', '0 3 * * *'],
    ['lista + intervalo', '0,30 * * * 1-5'],
    ['data fixa', '15 2 1 1 0'],
    ['nome de dia da semana', '0 3 * * MON'],
    ['intervalo de dias por nome', '0 3 * * MON-FRI'],
  ])('aceita %s (%s)', async (_rotulo, cron) => {
    // Os três primeiros casos eram recusados antes. A validação era uma regex
    // escrita à mão em que a classe `[0-9,\-/]` não continha `*` e a
    // alternativa `\*` só casava com asterisco sozinho — então `*/15` não
    // passava, e nenhum agendamento por intervalo podia ser salvo. Hoje a
    // validação usa o `cron-parser`, o MESMO parser que o BullMQ usa para
    // executar, o que elimina a chance de as duas regras divergirem.
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: true, syncCron: cron },
    });

    expect(r.statusCode).toBe(200);
    expect(argDaChamada<{ data: { syncCron: string } }>(sheetApiDb.update).data.syncCron).toBe(cron);
  });

  it.each([
    ['4 campos', '* * * *'],
    ['6 campos (com segundos)', '* * * * * *'],
    ['texto solto', 'nao sou cron'],
    ['só hífens — passava na regex antiga', '- - - - -'],
    ['valores fora de faixa — passavam na regex antiga', '99 99 99 99 99'],
    ['hora 25 não existe', '0 25 * * *'],
  ])('recusa %s → 400 e não grava', async (_rotulo, cron) => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: true, syncCron: cron },
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().message).toBe('Invalid sync settings.');
    expect(sheetApiDb.update).not.toHaveBeenCalled();
  });

  it('recusa corpo sem syncEnabled (campo obrigatório)', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncCron: '0 3 * * *' },
    });

    expect(r.statusCode).toBe(400);
    expect(sheetApiDb.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /:id/sync — ligar exige cron', () => {
  it('ligar sem cron no corpo E sem cron salvo → 400, nada gravado', async () => {
    comRegistro({ syncCron: null });

    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: true },
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().message).toBe('A cron expression is required to enable sync.');
    expect(sheetApiDb.update).not.toHaveBeenCalled();
    expect(fila.updateSyncSchedule).not.toHaveBeenCalled();
  });

  it('ligar sem cron no corpo mas COM cron salvo → usa o salvo', async () => {
    comRegistro({ syncCron: '0 4 * * *' });

    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: true },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ sync: { syncEnabled: true, syncCron: '0 4 * * *' } });
    expect(fila.updateSyncSchedule).toHaveBeenCalledWith('api-1', '0 4 * * *', 'user-1', 'planilha-abc');
  });
});

describe('PATCH /:id/sync — espelho entre banco e fila', () => {
  it('ligar com cron válido agenda o job e NÃO remove nada', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: true, syncCron: '0 3 * * *' },
    });

    expect(r.statusCode).toBe(200);
    // A ordem dos argumentos importa: (sheetApiId, cron, userId, spreadsheetId).
    // Trocar userId com spreadsheetId faria o worker sincronizar com o OAuth
    // errado — falha silenciosa, não erro de tipo (o Prisma aqui é `any`).
    expect(fila.updateSyncSchedule).toHaveBeenCalledWith('api-1', '0 3 * * *', 'user-1', 'planilha-abc');
    expect(fila.removeSyncSchedule).not.toHaveBeenCalled();
  });

  it('desligar remove o job repetível e NÃO agenda', async () => {
    comRegistro({ syncEnabled: true, syncCron: '0 3 * * *' });

    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: false },
    });

    expect(r.statusCode).toBe(200);
    expect(fila.removeSyncSchedule).toHaveBeenCalledWith('api-1');
    expect(fila.updateSyncSchedule).not.toHaveBeenCalled();
  });

  it('desligar preserva o cron salvo (só o job sai; a configuração fica)', async () => {
    comRegistro({ syncEnabled: true, syncCron: '0 3 * * *' });

    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: false },
    });

    expect(r.json().sync).toEqual({ syncEnabled: false, syncCron: '0 3 * * *' });
  });

  it('ligar apagando o cron (syncCron: null) passa na validação e deixa o registro incoerente', async () => {
    // Armadilha real: o guard é `syncEnabled && !syncCron && !existing.syncCron`.
    // Com cron salvo, mandar `syncCron: null` escapa do guard, grava
    // syncEnabled=true com syncCron=null e cai no ramo `else` → o job é
    // REMOVIDO. Resultado: a UI mostra "sincronização ligada" e nada sincroniza.
    comRegistro({ syncCron: '0 3 * * *' });

    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: true, syncCron: null },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().sync).toEqual({ syncEnabled: true, syncCron: null });
    expect(fila.removeSyncSchedule).toHaveBeenCalledWith('api-1');
    expect(fila.updateSyncSchedule).not.toHaveBeenCalled();
  });
});

describe('PATCH /:id/sync — null apaga, ausente preserva', () => {
  it('syncCron: null explícito vai como null para o update (apaga)', async () => {
    comRegistro({ syncCron: '0 3 * * *' });

    await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: false, syncCron: null },
    });

    const chamada = argDaChamada<DadosUpdate>(sheetApiDb.update);
    expect(chamada.where).toEqual({ id: 'api-1' });
    expect(chamada.data.syncCron).toBeNull();
  });

  it('syncCron ausente vai como undefined — o Prisma entende "não mexe"', async () => {
    comRegistro({ syncCron: '0 3 * * *' });

    await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: true },
    });

    const { data } = argDaChamada<DadosUpdate>(sheetApiDb.update);
    // A chave existe no objeto, mas com valor `undefined`: é assim que o
    // Prisma distingue "não mexe" (undefined) de "apaga" (null).
    expect('syncCron' in data).toBe(true);
    expect(data.syncCron).toBeUndefined();
    expect(data.syncEnabled).toBe(true);
  });

  it('o update sempre grava syncEnabled, mesmo quando não mudou', async () => {
    comRegistro({ syncEnabled: false });

    await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: false },
    });

    expect(argDaChamada<DadosUpdate>(sheetApiDb.update).data.syncEnabled).toBe(false);
  });
});

describe('PATCH /:id/sync — invalidação do cache da SheetApi', () => {
  // Sem esta chamada, o registro cacheado (TTL 300s) continuaria dizendo
  // syncEnabled/syncCron antigos por até 5 minutos após a mudança.
  it('invalida o cache ao ligar', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: true, syncCron: '0 3 * * *' },
    });

    expect(invalidateSheetApiCache).toHaveBeenCalledTimes(1);
    // Recebe o registro ATUALIZADO (id + slug), que é o que a função usa para
    // limpar as duas formas de lookup (por id e por slug).
    const registro = argDaChamada<{ id: string; slug: string | null; syncEnabled: boolean }>(
      invalidateSheetApiCache as unknown as { mock: { calls: unknown[][] } },
    );
    expect(registro.id).toBe('api-1');
    expect(registro.slug).toBe('minha-api');
    expect(registro.syncEnabled).toBe(true);
  });

  it('invalida o cache ao desligar também', async () => {
    comRegistro({ syncEnabled: true, syncCron: '0 3 * * *' });

    await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: false },
    });

    expect(invalidateSheetApiCache).toHaveBeenCalledTimes(1);
  });

  it('não invalida nada quando a validação falha', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/sync',
      payload: { syncEnabled: true, syncCron: 'nao sou cron' },
    });

    expect(invalidateSheetApiCache).not.toHaveBeenCalled();
  });
});

describe('POST /dashboard/apis/:id/sync/trigger', () => {
  it('invalida o cache da planilha e devolve 200', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/sync/trigger' });

    expect(r.statusCode).toBe(200);
    expect(r.json().triggered).toBe(true);
    expect(r.json().message).toContain('Cache invalidated');
    expect(sheetsService.invalidateCache).toHaveBeenCalledWith('planilha-abc');
  });

  it('NÃO enfileira nada — "trigger" só derruba cache, não força sync', async () => {
    // O nome da rota promete mais do que ela faz: não há job de sincronização
    // imediato, apenas invalidação para que o PRÓXIMO request busque dados
    // frescos. Quem clica no botão e espera dados novos no dashboard sem fazer
    // outro request não vê nada acontecer.
    await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/sync/trigger' });

    expect(fila.updateSyncSchedule).not.toHaveBeenCalled();
    expect(fila.removeSyncSchedule).not.toHaveBeenCalled();
    expect(sheetApiDb.update).not.toHaveBeenCalled();
  });

  it('funciona com a sincronização desligada (não checa syncEnabled)', async () => {
    comRegistro({ syncEnabled: false, syncCron: null });

    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/sync/trigger' });

    expect(r.statusCode).toBe(200);
    expect(sheetsService.invalidateCache).toHaveBeenCalledWith('planilha-abc');
  });
});
