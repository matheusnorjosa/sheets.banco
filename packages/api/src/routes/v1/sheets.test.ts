/**
 * Testes de caracterização de `routes/v1/sheets.ts` — o núcleo da API.
 *
 * 886 linhas, 16 rotas, e até aqui 0% de cobertura. Como cobrir tudo de uma
 * vez seria um arquivo impossível de revisar, este foca no que causa dano
 * irreversível se quebrar:
 *
 *   1. **Feature gates** (`allowRead/Create/Update/Delete`). São a única coisa
 *      entre uma chave com escopo de escrita e a planilha de produção. Se um
 *      gate parar de barrar, o dado do cliente é sobrescrito e não tem
 *      "desfazer" no Google Sheets.
 *   2. **`PUT ?layout=raw&range=`** — escreve num retângulo arbitrário da
 *      planilha. É a rota com maior poder de estrago do sistema inteiro; um
 *      range mal validado apaga a coluna errada.
 *   3. **Assíncrono vs síncrono** — sem `?sync=true` a escrita vai pra fila e
 *      responde 202. Confundir isso faz o chamador achar que gravou.
 *
 * Google Sheets, Prisma, cache e fila são mockados: o alvo é a lógica de
 * decisão da rota, não o driver do Google.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const sheetsService = {
  getRows: vi.fn().mockResolvedValue([]),
  updateRange: vi.fn().mockResolvedValue({ updatedCells: 4 }),
  appendRows: vi.fn().mockResolvedValue(1),
  updateRows: vi.fn().mockResolvedValue(1),
  deleteRows: vi.fn().mockResolvedValue(1),
  clearAllRows: vi.fn().mockResolvedValue(3),
  getSheetNames: vi.fn().mockResolvedValue(['Página1']),
  getSpreadsheetMetadata: vi.fn().mockResolvedValue({ title: 'Planilha' }),
  getValues: vi.fn().mockResolvedValue([]),
};
vi.mock('../../services/google-sheets.service.js', () => sheetsService);

const enqueueWrite = vi.fn().mockResolvedValue('job-1');
vi.mock('../../queues/sheets-write.queue.js', () => ({ enqueueWrite }));

// A SheetApi devolvida pelo resolver. Cada teste sobrescreve o que precisa.
let apiAtual: Record<string, unknown>;
const findSheetApiCached = vi.fn(async () => apiAtual);
vi.mock('../../services/sheet-api-cache.service.js', () => ({ findSheetApiCached }));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    sheetApi: { findUnique: vi.fn(), findFirst: vi.fn() },
    additionalSheet: { findFirst: vi.fn().mockResolvedValue(null) },
    snapshot: { findUnique: vi.fn().mockResolvedValue(null) },
    computedField: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../../config/env.js', () => ({
  env: { RATE_LIMIT_MAX: 10000, RATE_LIMIT_WINDOW: '1 minute', DEFAULT_CACHE_TTL: 60 },
}));

// A autenticação por API tem suite própria (api-auth.test.ts, 31 testes).
// Aqui ela é neutralizada para que a falha de um teste aponte a rota, e não
// a credencial.
vi.mock('../../middleware/api-auth.js', () => ({ apiAuth: async () => {} }));
vi.mock('../../middleware/cors.js', () => ({ apiCors: async () => {} }));
vi.mock('../../middleware/ip-whitelist.js', () => ({ apiIpWhitelist: async () => {} }));
vi.mock('../../middleware/hmac-verify.js', () => ({ hmacVerify: async () => {} }));

const { montarApp, argDaChamada } = await import('../../test-utils/app.js');
const { sheetsRoutes } = await import('./sheets.js');

let app: FastifyInstance;

/** SheetApi com tudo liberado; os testes restringem o que querem provar. */
function api(over: Record<string, unknown> = {}) {
  return {
    id: 'api-1',
    slug: null,
    userId: 'user-1',
    spreadsheetId: 'planilha-abc',
    allowRead: true,
    allowCreate: true,
    allowUpdate: true,
    allowDelete: true,
    cacheTtlSeconds: 0,
    rateLimitRpm: 10000,
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  sheetsService.getRows.mockResolvedValue([]);
  sheetsService.updateRange.mockResolvedValue({ updatedCells: 4 });
  enqueueWrite.mockResolvedValue('job-1');
  apiAtual = api();
  app = await montarApp({ rotas: sheetsRoutes, prefixo: '/api/v1' });
});

describe('resolução da SheetApi', () => {
  it('apiId inexistente dá 404', async () => {
    findSheetApiCached.mockResolvedValueOnce(null as never);
    const r = await app.inject({ method: 'GET', url: '/api/v1/nao-existe' });
    expect(r.statusCode).toBe(404);
  });
});

describe('feature gates — a única barreira antes da planilha', () => {
  it('allowCreate=false bloqueia POST com 403 e NÃO enfileira', async () => {
    apiAtual = api({ allowCreate: false });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/api-1', payload: { data: { nome: 'x' } },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('CREATE_DISABLED');
    expect(enqueueWrite).not.toHaveBeenCalled();
    expect(sheetsService.appendRows).not.toHaveBeenCalled();
  });

  it('allowUpdate=false bloqueia PUT com 403 e NÃO escreve', async () => {
    apiAtual = api({ allowUpdate: false });
    const r = await app.inject({
      method: 'PUT', url: '/api/v1/api-1?layout=raw&range=A1:B2',
      payload: { values: [['a', 'b']] },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('UPDATE_DISABLED');
    expect(sheetsService.updateRange).not.toHaveBeenCalled();
  });

  it('allowDelete=false bloqueia DELETE por coluna', async () => {
    apiAtual = api({ allowDelete: false });
    const r = await app.inject({ method: 'DELETE', url: '/api/v1/api-1/cpf/123' });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('DELETE_DISABLED');
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('allowDelete=false bloqueia DELETE /all — o mais destrutivo de todos', async () => {
    apiAtual = api({ allowDelete: false });
    const r = await app.inject({ method: 'DELETE', url: '/api/v1/api-1/all' });
    expect(r.statusCode).toBe(403);
    expect(sheetsService.clearAllRows).not.toHaveBeenCalled();
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('o gate é checado ANTES de validar o corpo — corpo inválido em API travada ainda dá 403', async () => {
    // Ordem importa: se a validação viesse primeiro, um 400 revelaria que a
    // rota existe e é gravável antes de dizer que está proibida.
    apiAtual = api({ allowCreate: false });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/api-1', payload: { lixo: true },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('PUT ?layout=raw&range= — a escrita de maior poder', () => {
  it('grava o retângulo quando tudo está correto', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/api/v1/api-1?layout=raw&range=AL2:AR608',
      payload: { values: [['a', 'b'], ['c', 'd']] },
    });

    expect(r.statusCode).toBe(200);
    const args = sheetsService.updateRange.mock.calls[0];
    expect(args?.[3]).toBe('AL2:AR608');
    expect(args?.[4]).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('exige layout=raw — sem ele recusa', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/api/v1/api-1?range=A1:B2',
      payload: { values: [['a']] },
    });
    expect(r.statusCode).toBe(400);
    expect(sheetsService.updateRange).not.toHaveBeenCalled();
  });

  it('exige range — sem ele recusa (senão escreveria em lugar indefinido)', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/api/v1/api-1?layout=raw',
      payload: { values: [['a']] },
    });
    expect(r.statusCode).toBe(400);
    expect(sheetsService.updateRange).not.toHaveBeenCalled();
  });

  it.each([
    ['1:5', 'só linha, sem coluna'],
    ['=A1', 'tentativa de fórmula'],
    ['A1; DROP', 'lixo com separador'],
    ['', 'vazio'],
  ])('recusa range inválido %s (%s)', async (range) => {
    const r = await app.inject({
      method: 'PUT', url: `/api/v1/api-1?layout=raw&range=${encodeURIComponent(range)}`,
      payload: { values: [['a']] },
    });
    expect(r.statusCode).toBe(400);
    expect(sheetsService.updateRange).not.toHaveBeenCalled();
  });

  it.each([
    ['A', 'coluna A inteira'],
    ['A1:B', 'de A1 até o fim da coluna B'],
    ['A:C', 'colunas A a C inteiras'],
  ])('ACEITA %s (%s) — o regex usa \\d* de propósito', async (range) => {
    // `A1_RANGE_RE = /^[A-Za-z]+\d*(:[A-Za-z]+\d*)?$/` — o `\d*` (zero ou
    // mais) permite notação de coluna inteira, que é A1 válida no Sheets.
    // Note a assimetria deliberada: coluna sem linha passa, mas linha sem
    // coluna ('1:5') não. Se alguém "consertar" o regex para \d+, estas
    // escritas legítimas quebram.
    const r = await app.inject({
      method: 'PUT', url: `/api/v1/api-1?layout=raw&range=${encodeURIComponent(range)}`,
      payload: { values: [['a']] },
    });
    expect(r.statusCode).toBe(200);
    expect(sheetsService.updateRange).toHaveBeenCalled();
  });

  it('recusa corpo sem values', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/api/v1/api-1?layout=raw&range=A1:B2',
      payload: { dados: [['a']] },
    });
    expect(r.statusCode).toBe(400);
    expect(sheetsService.updateRange).not.toHaveBeenCalled();
  });

  it('recusa values vazio — evita apagar o range sem querer', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/api/v1/api-1?layout=raw&range=A1:B2',
      payload: { values: [] },
    });
    expect(r.statusCode).toBe(400);
    expect(sheetsService.updateRange).not.toHaveBeenCalled();
  });
});

describe('assíncrono por padrão, síncrono sob demanda', () => {
  it('POST sem ?sync enfileira e responde 202 (não gravou ainda)', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/v1/api-1', payload: { data: { nome: 'x' } },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ queued: true, jobId: 'job-1' });
    expect(sheetsService.appendRows).not.toHaveBeenCalled();
  });

  it('POST com ?sync=true grava na hora e responde 201', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/v1/api-1?sync=true', payload: { data: { nome: 'x' } },
    });
    expect(r.statusCode).toBe(201);
    expect(sheetsService.appendRows).toHaveBeenCalled();
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('aceita array de objetos, não só um', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/api-1?sync=true',
      payload: { data: [{ nome: 'Ana' }, { nome: 'Bia' }] },
    });
    expect(argDaChamada<Record<string, string>[]>(sheetsService.appendRows, 0, 2)).toHaveLength(2);
  });

  it('recusa valor numérico — o schema exige string em todo campo', async () => {
    // `createBodySchema` usa `z.record(z.string(), z.string())`: os valores
    // TÊM que ser string. Mandar `{ n: 1 }` dá 400, não 201. Vale saber antes
    // de escrever cliente: número precisa ir como "1".
    const r = await app.inject({
      method: 'POST', url: '/api/v1/api-1?sync=true',
      payload: { data: { quantidade: 42 } },
    });
    expect(r.statusCode).toBe(400);
    expect(sheetsService.appendRows).not.toHaveBeenCalled();
  });

  it('DELETE /all com ?sync=true limpa na hora', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/v1/api-1/all?sync=true' });
    expect(r.statusCode).toBe(200);
    expect(sheetsService.clearAllRows).toHaveBeenCalled();
  });

  it('DELETE por coluna sem ?sync enfileira com a condição certa', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/v1/api-1/cpf/12345' });
    expect(r.statusCode).toBe(202);
    const job = argDaChamada<{ type: string; column: string; value: string }>(enqueueWrite);
    expect(job.type).toBe('delete');
    expect(job.column).toBe('cpf');
    expect(job.value).toBe('12345');
  });
});

describe('GET /:apiId', () => {
  it('devolve as linhas da planilha', async () => {
    sheetsService.getRows.mockResolvedValue([{ nome: 'Ana' }, { nome: 'Bia' }]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(2);
  });

  it('repassa ?sheet= para o serviço — é como se escolhe a aba', async () => {
    // Armadilha conhecida: sem ?sheet= vem só a PRIMEIRA aba. Este teste
    // trava o repasse do parâmetro.
    await app.inject({ method: 'GET', url: '/api/v1/api-1?sheet=Vidas' });
    expect(sheetsService.getRows.mock.calls[0]?.[2]).toBe('Vidas');
  });
});
