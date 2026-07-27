/**
 * Testes de caracterização de `routes/dashboard/snapshots.ts`.
 *
 * Por que este arquivo merece teste (estava com 0% de cobertura):
 *
 *   1. **Posse.** As quatro rotas dependem de um único `sheetApi.findFirst({ id, userId })`
 *      para decidir se o usuário pode mexer no snapshot. Se esse filtro cair,
 *      qualquer usuário logado lê/apaga o histórico de planilha de outro — e o
 *      snapshot guarda a planilha INTEIRA no campo `data` (PII inclusa).
 *   2. **Versionamento.** `nextVersion = (última ?? 0) + 1` é a única coisa que
 *      impede colisão na chave composta `sheetApiId_version`. Um refactor que
 *      troque o `orderBy` ou o `?? 0` gera versões duplicadas.
 *   3. **Peso da listagem.** O `select` do `findMany` existe justamente para NÃO
 *      trazer o campo `data`. Reintroduzi-lo faria a tela de histórico baixar
 *      todas as versões completas da planilha.
 *
 * Prisma, Google Sheets e o jwtAuth são mockados: o alvo é a lógica da rota.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const sheetApiDb = { findFirst: vi.fn() };
const snapshotDb = {
  findFirst: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../../lib/prisma.js', () => ({
  prisma: { sheetApi: sheetApiDb, snapshot: snapshotDb },
}));

// Só `getRows` e `getColumnNames` são usados pelo alvo (conferido por grep).
// Mock incompleto aqui viraria 500 opaco em vez de erro claro.
const sheetsService = {
  getRows: vi.fn(),
  getColumnNames: vi.fn(),
};
vi.mock('../../services/google-sheets.service.js', () => sheetsService);

// O módulo de env valida as variáveis na importação e explode sem DATABASE_URL.
vi.mock('../../config/env.js', () => ({
  env: { RATE_LIMIT_DASHBOARD_MAX: 1000, RATE_LIMIT_DASHBOARD_WINDOW: '1 minute' },
}));

// jwtAuth real exigiria montar o plugin inteiro; as rotas só consomem
// `request.user.sub`.
vi.mock('../../middleware/jwt-auth.js', () => ({
  jwtAuth: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' };
  },
}));

const { montarApp, argDaChamada } = await import('../../test-utils/app.js');
const { snapshotRoutes } = await import('./snapshots.js');

let app: FastifyInstance;

const API = {
  id: 'api-1',
  userId: 'user-1',
  name: 'Minha API',
  spreadsheetId: 'planilha-abc',
};

/** Snapshot devolvido pelo Prisma — inclui o payload pesado `data`. */
const SNAPSHOT = {
  id: 'snap-1',
  sheetApiId: 'api-1',
  version: 3,
  data: [{ nome: 'Ana' }],
  headers: ['nome'],
  rowCount: 1,
  sheetName: null,
  createdAt: new Date('2026-07-01T12:00:00Z'),
};

beforeEach(async () => {
  vi.clearAllMocks();
  sheetApiDb.findFirst.mockResolvedValue(API);
  sheetsService.getRows.mockResolvedValue([]);
  sheetsService.getColumnNames.mockResolvedValue([]);
  snapshotDb.findFirst.mockResolvedValue(null);
  snapshotDb.create.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'snap-novo',
    createdAt: new Date('2026-07-27T00:00:00Z'),
    ...data,
  }));
  snapshotDb.findMany.mockResolvedValue([]);
  snapshotDb.findUnique.mockResolvedValue(null);
  snapshotDb.delete.mockResolvedValue({ id: 'snap-1' });
  app = await montarApp({ rotas: snapshotRoutes, prefixo: '/dashboard/apis' });
});

describe('posse da API — as quatro rotas dependem do mesmo filtro', () => {
  // `findFirst({ where: { id, userId } })` é o portão. Devolvendo null (API de
  // outro dono, ou inexistente) nenhuma das rotas pode seguir adiante.
  const rotas: Array<[string, 'GET' | 'POST' | 'DELETE', string]> = [
    ['POST criar', 'POST', '/dashboard/apis/api-de-outro/snapshots'],
    ['GET listar', 'GET', '/dashboard/apis/api-de-outro/snapshots'],
    ['GET versão', 'GET', '/dashboard/apis/api-de-outro/snapshots/1'],
    ['DELETE versão', 'DELETE', '/dashboard/apis/api-de-outro/snapshots/1'],
  ];

  it.each(rotas)('%s — API de outro dono dá 404', async (_nome, method, url) => {
    sheetApiDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({ method, url });

    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('NOT_FOUND');
    // Nada além da checagem de posse pode ter rodado.
    expect(snapshotDb.create).not.toHaveBeenCalled();
    expect(snapshotDb.findMany).not.toHaveBeenCalled();
    expect(snapshotDb.findUnique).not.toHaveBeenCalled();
    expect(snapshotDb.delete).not.toHaveBeenCalled();
  });

  it('o where da checagem cruza id E userId (não só id)', async () => {
    await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/snapshots' });

    const where = argDaChamada<{ where: { id: string; userId: string } }>(sheetApiDb.findFirst).where;
    expect(where).toEqual({ id: 'api-1', userId: 'user-1' });
  });
});

describe('POST /dashboard/apis/:id/snapshots — versionamento', () => {
  it('sem snapshot anterior cria a versão 1', async () => {
    snapshotDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/snapshots' });

    expect(r.statusCode).toBe(201);
    expect(argDaChamada<{ data: { version: number } }>(snapshotDb.create).data.version).toBe(1);
    expect(r.json().snapshot.version).toBe(1);
  });

  it('com última versão 7 cria a 8 (última + 1)', async () => {
    snapshotDb.findFirst.mockResolvedValue({ version: 7 });

    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/snapshots' });

    expect(r.statusCode).toBe(201);
    expect(argDaChamada<{ data: { version: number } }>(snapshotDb.create).data.version).toBe(8);
  });

  it('busca a última versão ordenando por version desc, escopada na API', async () => {
    await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/snapshots' });

    const consulta = argDaChamada<{
      where: { sheetApiId: string };
      orderBy: { version: string };
      select: Record<string, boolean>;
    }>(snapshotDb.findFirst);
    expect(consulta.where).toEqual({ sheetApiId: 'api-1' });
    expect(consulta.orderBy).toEqual({ version: 'desc' });
    // Só o número da versão é lido — não o payload inteiro do último snapshot.
    expect(consulta.select).toEqual({ version: true });
  });
});

describe('POST /dashboard/apis/:id/snapshots — conteúdo gravado', () => {
  it('grava rowCount igual ao número de linhas e headers vindos de getColumnNames', async () => {
    const linhas = [{ nome: 'Ana' }, { nome: 'Bia' }, { nome: 'Caio' }];
    sheetsService.getRows.mockResolvedValue(linhas);
    sheetsService.getColumnNames.mockResolvedValue(['nome', 'cpf']);

    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/snapshots' });

    expect(r.statusCode).toBe(201);
    const data = argDaChamada<{
      data: { sheetApiId: string; data: unknown[]; headers: string[]; rowCount: number };
    }>(snapshotDb.create).data;
    expect(data.sheetApiId).toBe('api-1');
    expect(data.data).toEqual(linhas);
    expect(data.rowCount).toBe(3);
    // `headers` NÃO é derivado das linhas: vem de `getColumnNames`, que enxerga
    // colunas sem valor nenhum (aqui 'cpf', ausente das linhas).
    expect(data.headers).toEqual(['nome', 'cpf']);
  });

  it('planilha vazia grava rowCount 0 (não quebra)', async () => {
    sheetsService.getRows.mockResolvedValue([]);
    sheetsService.getColumnNames.mockResolvedValue(['nome']);

    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/snapshots' });

    expect(r.statusCode).toBe(201);
    const data = argDaChamada<{ data: { rowCount: number; data: unknown[] } }>(snapshotDb.create).data;
    expect(data.rowCount).toBe(0);
    expect(data.data).toEqual([]);
  });

  it('lê a planilha com o userId do token (OAuth por-usuário) e o spreadsheetId da API', async () => {
    await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/snapshots' });

    expect(sheetsService.getRows).toHaveBeenCalledWith('user-1', 'planilha-abc', undefined, 0);
    expect(sheetsService.getColumnNames).toHaveBeenCalledWith('user-1', 'planilha-abc', undefined, 0);
  });
});

describe('POST /dashboard/apis/:id/snapshots — parâmetro ?sheet', () => {
  it('com ?sheet=Aba2 repassa a aba para getRows/getColumnNames e grava sheetName', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/snapshots?sheet=Aba2',
    });

    expect(r.statusCode).toBe(201);
    expect(argDaChamada<string>(sheetsService.getRows, 0, 2)).toBe('Aba2');
    expect(argDaChamada<string>(sheetsService.getColumnNames, 0, 2)).toBe('Aba2');
    expect(argDaChamada<{ data: { sheetName: string | null } }>(snapshotDb.create).data.sheetName).toBe('Aba2');
  });

  it('sem ?sheet grava sheetName null e manda undefined para o serviço', async () => {
    await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/snapshots' });

    expect(argDaChamada<string | undefined>(sheetsService.getRows, 0, 2)).toBeUndefined();
    expect(argDaChamada<{ data: { sheetName: string | null } }>(snapshotDb.create).data.sheetName).toBeNull();
  });
});

describe('GET /dashboard/apis/:id/snapshots — listagem', () => {
  it('NÃO traz o campo `data` no select (o payload inteiro da planilha)', async () => {
    await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/snapshots' });

    const consulta = argDaChamada<{
      where: { sheetApiId: string };
      orderBy: { version: string };
      select: Record<string, boolean | undefined>;
    }>(snapshotDb.findMany);

    // A regressão que este teste existe para pegar: trocar o `select` por um
    // findMany "simples" faria a listagem baixar todas as versões completas.
    expect(consulta.select.data).toBeUndefined();
    expect(consulta.select).toEqual({
      id: true,
      version: true,
      headers: true,
      rowCount: true,
      sheetName: true,
      createdAt: true,
    });
    expect(consulta.where).toEqual({ sheetApiId: 'api-1' });
  });

  it('ordena por version desc (mais recente primeiro)', async () => {
    await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/snapshots' });

    expect(argDaChamada<{ orderBy: { version: string } }>(snapshotDb.findMany).orderBy)
      .toEqual({ version: 'desc' });
  });

  it('devolve a lista sob a chave `snapshots`', async () => {
    snapshotDb.findMany.mockResolvedValue([
      { id: 's2', version: 2, headers: ['nome'], rowCount: 5, sheetName: null, createdAt: new Date() },
      { id: 's1', version: 1, headers: ['nome'], rowCount: 4, sheetName: null, createdAt: new Date() },
    ]);

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/snapshots' });

    expect(r.statusCode).toBe(200);
    expect(r.json().snapshots).toHaveLength(2);
    expect(r.json().snapshots[0].version).toBe(2);
  });

  it('sem snapshots devolve lista vazia, não 404', async () => {
    snapshotDb.findMany.mockResolvedValue([]);

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/snapshots' });

    expect(r.statusCode).toBe(200);
    expect(r.json().snapshots).toEqual([]);
  });
});

describe('GET /dashboard/apis/:id/snapshots/:version', () => {
  it('converte a versão da URL para NÚMERO na chave composta', async () => {
    snapshotDb.findUnique.mockResolvedValue(SNAPSHOT);

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/snapshots/3' });

    expect(r.statusCode).toBe(200);
    const where = argDaChamada<{
      where: { sheetApiId_version: { sheetApiId: string; version: number } };
    }>(snapshotDb.findUnique).where;
    // Sem o `Number()` o Prisma receberia a string '3' e o findUnique estouraria
    // com erro de validação (500), não 404.
    expect(where.sheetApiId_version.version).toBe(3);
    expect(typeof where.sheetApiId_version.version).toBe('number');
    expect(where.sheetApiId_version.sheetApiId).toBe('api-1');
  });

  it('devolve o snapshot COM o campo data (aqui o payload é o ponto)', async () => {
    snapshotDb.findUnique.mockResolvedValue(SNAPSHOT);

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/snapshots/3' });

    expect(r.json().snapshot.data).toEqual([{ nome: 'Ana' }]);
  });

  it('versão inexistente dá 404', async () => {
    snapshotDb.findUnique.mockResolvedValue(null);

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/snapshots/99' });

    expect(r.statusCode).toBe(404);
    expect(r.json().message).toBe('Snapshot not found.');
  });
});

describe('DELETE /dashboard/apis/:id/snapshots/:version', () => {
  it('apaga pelo id do snapshot encontrado, não pela chave composta', async () => {
    snapshotDb.findUnique.mockResolvedValue(SNAPSHOT);

    const r = await app.inject({ method: 'DELETE', url: '/dashboard/apis/api-1/snapshots/3' });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ deleted: true });
    expect(argDaChamada<{ where: { id: string } }>(snapshotDb.delete).where).toEqual({ id: 'snap-1' });
  });

  it('versão inexistente dá 404 e não chama delete', async () => {
    snapshotDb.findUnique.mockResolvedValue(null);

    const r = await app.inject({ method: 'DELETE', url: '/dashboard/apis/api-1/snapshots/99' });

    expect(r.statusCode).toBe(404);
    expect(r.json().message).toBe('Snapshot not found.');
    expect(snapshotDb.delete).not.toHaveBeenCalled();
  });
});

describe('versão não-numérica na URL — comportamento ATUAL (possível bug)', () => {
  // `Number('abc')` é NaN e vai assim para o Prisma: não há validação de rota
  // nem checagem de `Number.isInteger`. Em produção o Prisma recusa NaN num
  // campo Int e o erro sobe como 500 — não como 400/404. Com o Prisma mockado
  // aqui a resposta acaba sendo 404, então o que este teste TRAVA é o valor
  // repassado, não o status.
  it('GET /snapshots/abc manda NaN para o Prisma', async () => {
    snapshotDb.findUnique.mockResolvedValue(null);

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/snapshots/abc' });

    const where = argDaChamada<{
      where: { sheetApiId_version: { version: number } };
    }>(snapshotDb.findUnique).where;
    expect(Number.isNaN(where.sheetApiId_version.version)).toBe(true);
    expect(r.statusCode).toBe(404);
  });

  it('DELETE /snapshots/abc idem — NaN chega ao Prisma sem validação', async () => {
    snapshotDb.findUnique.mockResolvedValue(null);

    const r = await app.inject({ method: 'DELETE', url: '/dashboard/apis/api-1/snapshots/abc' });

    const where = argDaChamada<{
      where: { sheetApiId_version: { version: number } };
    }>(snapshotDb.findUnique).where;
    expect(Number.isNaN(where.sheetApiId_version.version)).toBe(true);
    expect(r.statusCode).toBe(404);
  });

  it('versão decimal (1.5) também passa sem validação', async () => {
    snapshotDb.findUnique.mockResolvedValue(null);

    await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/snapshots/1.5' });

    const where = argDaChamada<{
      where: { sheetApiId_version: { version: number } };
    }>(snapshotDb.findUnique).where;
    expect(where.sheetApiId_version.version).toBe(1.5);
  });
});
