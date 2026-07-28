/**
 * Testes de caracterização de `routes/dashboard/multi-spreadsheet.ts`.
 *
 * Por que este arquivo merece teste (estava com 0% de cobertura):
 *
 *   1. **Posse é a única defesa.** As três rotas recebem o `:id` da SheetApi
 *      vindo da URL e só o `findFirst({ id, userId })` impede que um usuário
 *      liste, vincule ou apague planilhas de uma API de OUTRO dono. Se esse
 *      filtro sumir num refactor, vira IDOR — e nada hoje avisaria.
 *   2. **`extractSpreadsheetId` é silenciosamente permissivo.** Quando a string
 *      não casa o padrão `/spreadsheets/d/<id>`, ela é usada INTEIRA como
 *      spreadsheetId. Um typo de URL vira um registro com "id" lixo.
 *   3. **A ordem das checagens custa dinheiro/quota.** A validação de acesso no
 *      Google acontece ANTES da checagem de duplicata: tentar vincular uma
 *      planilha já vinculada gasta uma chamada à API do Google mesmo assim.
 *
 * Prisma, Google Sheets e o `jwtAuth` são mockados: o alvo é a lógica da rota.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const sheetApiDb = { findFirst: vi.fn() };
const additionalSheetDb = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../../lib/prisma.js', () => ({
  prisma: { sheetApi: sheetApiDb, additionalSheet: additionalSheetDb },
}));

// `getColumnNames` é a ÚNICA função do serviço usada aqui (conferido com
// `grep -o "sheetsService\.[a-zA-Z]*"`). Mock incompleto daria 500 opaco.
const sheetsService = { getColumnNames: vi.fn() };
vi.mock('../../services/google-sheets.service.js', () => sheetsService);

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
const { multiSpreadsheetRoutes } = await import('./multi-spreadsheet.js');

let app: FastifyInstance;

const API = {
  id: 'api-1',
  userId: 'user-1',
  name: 'Agenda 2026',
  spreadsheetId: 'planilha-primaria',
};

const URL_COMPLETA = 'https://docs.google.com/spreadsheets/d/1AbC-_123/edit#gid=0';

beforeEach(async () => {
  vi.clearAllMocks();
  sheetApiDb.findFirst.mockResolvedValue(API);
  additionalSheetDb.findMany.mockResolvedValue([]);
  additionalSheetDb.findUnique.mockResolvedValue(null);
  additionalSheetDb.findFirst.mockResolvedValue(null);
  additionalSheetDb.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'add-novo',
    createdAt: new Date('2026-07-27T12:00:00.000Z'),
    ...data,
  }));
  additionalSheetDb.delete.mockResolvedValue({ id: 'add-1' });
  sheetsService.getColumnNames.mockResolvedValue(['nome', 'idade']);
  app = await montarApp({ rotas: multiSpreadsheetRoutes, prefixo: '/dashboard/apis' });
});

describe('posse da SheetApi — API de outro dono não existe', () => {
  // `findFirst({ id, userId })` devolvendo null é o que separa "não existe" de
  // "não é sua". As três rotas precisam responder 404 nos dois casos.
  beforeEach(() => {
    sheetApiDb.findFirst.mockResolvedValue(null);
  });

  it('GET dá 404 e nem consulta as planilhas adicionais', async () => {
    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-de-outro/spreadsheets' });

    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('NOT_FOUND');
    expect(additionalSheetDb.findMany).not.toHaveBeenCalled();
  });

  it('POST dá 404 antes de validar o corpo ou tocar no Google', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-de-outro/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA, label: 'Extra' },
    });

    expect(r.statusCode).toBe(404);
    expect(sheetsService.getColumnNames).not.toHaveBeenCalled();
    expect(additionalSheetDb.create).not.toHaveBeenCalled();
  });

  it('DELETE dá 404 e não apaga nada', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/dashboard/apis/api-de-outro/spreadsheets/add-1',
    });

    expect(r.statusCode).toBe(404);
    expect(additionalSheetDb.delete).not.toHaveBeenCalled();
  });
});

describe('GET /dashboard/apis/:id/spreadsheets', () => {
  it('devolve a primária + as adicionais, usando o NOME da API como label da primária', async () => {
    // A planilha primária não tem registro em `additionalSheet`: ela é
    // sintetizada a partir da própria SheetApi, e o `label` exposto é o
    // `name` da API — não há campo de label próprio para ela.
    additionalSheetDb.findMany.mockResolvedValue([
      { id: 'add-1', sheetApiId: 'api-1', spreadsheetId: 'planilha-2', label: 'Banco' },
      { id: 'add-2', sheetApiId: 'api-1', spreadsheetId: 'planilha-3', label: 'Usuários' },
    ]);

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/spreadsheets' });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      primary: { spreadsheetId: 'planilha-primaria', label: 'Agenda 2026' },
      additional: [
        { id: 'add-1', sheetApiId: 'api-1', spreadsheetId: 'planilha-2', label: 'Banco' },
        { id: 'add-2', sheetApiId: 'api-1', spreadsheetId: 'planilha-3', label: 'Usuários' },
      ],
    });
  });

  it('sem adicionais devolve lista vazia (nunca null)', async () => {
    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/spreadsheets' });

    expect(r.statusCode).toBe(200);
    expect(r.json().additional).toEqual([]);
    expect(r.json().primary.label).toBe('Agenda 2026');
  });

  it('filtra por sheetApiId e ordena por createdAt asc', async () => {
    await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/spreadsheets' });

    const consulta = argDaChamada<{
      where: { sheetApiId: string };
      orderBy: { createdAt: string };
    }>(additionalSheetDb.findMany);
    expect(consulta.where.sheetApiId).toBe('api-1');
    expect(consulta.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('o select da posse não puxa segredo da SheetApi', async () => {
    await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/spreadsheets' });

    const consulta = argDaChamada<{
      where: { id: string; userId: string };
      select: Record<string, unknown>;
    }>(sheetApiDb.findFirst);
    expect(consulta.where).toEqual({ id: 'api-1', userId: 'user-1' });
    expect(consulta.select).toEqual({ id: true, spreadsheetId: true, name: true });
  });
});

describe('extractSpreadsheetId — o que entra como "URL"', () => {
  it('extrai o ID de uma URL completa do Google Sheets', async () => {
    await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA, label: 'Extra' },
    });

    // O `/edit#gid=0` é descartado; o hífen e o underscore fazem parte do ID.
    expect(argDaChamada<string>(sheetsService.getColumnNames, 0, 1)).toBe('1AbC-_123');
    expect(argDaChamada<{ data: { spreadsheetId: string } }>(additionalSheetDb.create).data.spreadsheetId)
      .toBe('1AbC-_123');
  });

  it('ID cru passa inalterado', async () => {
    await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: '1AbC-_123', label: 'Extra' },
    });

    expect(argDaChamada<{ data: { spreadsheetId: string } }>(additionalSheetDb.create).data.spreadsheetId)
      .toBe('1AbC-_123');
  });

  it('URL que NÃO casa o padrão vira o spreadsheetId inteiro (comportamento atual)', async () => {
    // Não há validação de formato: qualquer string não vazia que o Google
    // aceite (ou finja aceitar) é gravada como ID. Aqui `getColumnNames` é
    // chamado com a URL inteira. Só o try/catch em volta dele segura o lixo —
    // se o serviço não rejeitar, o registro entra no banco assim.
    await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: 'https://exemplo.com/x', label: 'Extra' },
    });

    expect(argDaChamada<string>(sheetsService.getColumnNames, 0, 1)).toBe('https://exemplo.com/x');
    expect(argDaChamada<{ data: { spreadsheetId: string } }>(additionalSheetDb.create).data.spreadsheetId)
      .toBe('https://exemplo.com/x');
  });
});

describe('POST /dashboard/apis/:id/spreadsheets — validação do corpo', () => {
  it('sem label dá 400 e nem chega no Google', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA },
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('VALIDATION_ERROR');
    expect(sheetsService.getColumnNames).not.toHaveBeenCalled();
    expect(additionalSheetDb.create).not.toHaveBeenCalled();
  });

  it('label com 101 chars dá 400 — com a mensagem genérica de campo faltando', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA, label: 'x'.repeat(101) },
    });

    expect(r.statusCode).toBe(400);
    // A mensagem não diz "label longo demais": todo erro do zod vira o mesmo
    // texto 'Provide "spreadsheetUrl" and "label".'
    expect(r.json().message).toBe('Provide "spreadsheetUrl" and "label".');
    expect(additionalSheetDb.create).not.toHaveBeenCalled();
  });

  it('label com exatamente 100 chars passa (limite é inclusivo)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA, label: 'x'.repeat(100) },
    });

    expect(r.statusCode).toBe(201);
  });

  it('spreadsheetUrl vazia dá 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: '', label: 'Extra' },
    });

    expect(r.statusCode).toBe(400);
    expect(additionalSheetDb.create).not.toHaveBeenCalled();
  });

  it('corpo ausente dá 400 (sem 500)', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/spreadsheets' });

    expect(r.statusCode).toBe(400);
    expect(additionalSheetDb.create).not.toHaveBeenCalled();
  });
});

describe('POST /dashboard/apis/:id/spreadsheets — acesso e duplicata', () => {
  it('sucesso devolve 201 com o registro criado', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA, label: 'Planilha Banco' },
    });

    expect(r.statusCode).toBe(201);
    expect(r.json().sheet).toMatchObject({
      id: 'add-novo',
      sheetApiId: 'api-1',
      spreadsheetId: '1AbC-_123',
      label: 'Planilha Banco',
    });
    // O userId vem do JWT, não do corpo — nunca do que o cliente mandou.
    expect(argDaChamada<string>(sheetsService.getColumnNames, 0, 0)).toBe('user-1');
  });

  it('sem acesso no Google devolve 400 (não 403) e NÃO grava', async () => {
    // Qualquer falha do serviço — permissão, planilha inexistente, rede — é
    // achatada num único ValidationError 400. Um 500 do Google vira 400 aqui.
    sheetsService.getColumnNames.mockRejectedValue(new Error('The caller does not have permission'));

    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA, label: 'Extra' },
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('VALIDATION_ERROR');
    expect(r.json().message).toBe(
      'Could not access the spreadsheet. Make sure it is shared with your Google account.',
    );
    // A checagem de duplicata acontece ANTES do acesso ao Google, então ela
    // já rodou quando chegamos aqui — o que não pode ter acontecido é a
    // gravação.
    expect(additionalSheetDb.create).not.toHaveBeenCalled();
  });

  it('planilha já vinculada devolve 400 e não grava de novo', async () => {
    additionalSheetDb.findUnique.mockResolvedValue({
      id: 'add-1', sheetApiId: 'api-1', spreadsheetId: '1AbC-_123', label: 'Já existe',
    });

    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA, label: 'Extra' },
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().message).toBe('This spreadsheet is already linked to this API.');
    expect(additionalSheetDb.create).not.toHaveBeenCalled();
  });

  it('a duplicata é procurada pela chave composta sheetApiId_spreadsheetId', async () => {
    await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA, label: 'Extra' },
    });

    // A unicidade é por API, não global: a MESMA planilha pode estar vinculada
    // a duas SheetApis diferentes.
    expect(argDaChamada<{ where: Record<string, unknown> }>(additionalSheetDb.findUnique).where).toEqual({
      sheetApiId_spreadsheetId: { sheetApiId: 'api-1', spreadsheetId: '1AbC-_123' },
    });
  });

  it('ORDEM: checa duplicata ANTES de gastar cota do Google', async () => {
    // Antes era o inverso: mesmo com a planilha já vinculada (400 garantido),
    // a chamada ao Google acontecia. Um cliente com retry em cima de planilha
    // repetida queimava cota da Sheets API para sempre receber o mesmo erro.
    const ordem: string[] = [];
    sheetsService.getColumnNames.mockImplementation(async () => {
      ordem.push('getColumnNames');
      return ['nome'];
    });
    additionalSheetDb.findUnique.mockImplementation(async () => {
      ordem.push('findUnique');
      return { id: 'add-1', spreadsheetId: '1AbC-_123' };
    });

    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA, label: 'Extra' },
    });

    expect(r.statusCode).toBe(400);
    expect(ordem).toEqual(['findUnique']);
    expect(sheetsService.getColumnNames).not.toHaveBeenCalled();
  });

  it('planilha NOVA ainda valida o acesso no Google', async () => {
    // Contraponto: inverter a ordem não podia virar "nunca valida".
    additionalSheetDb.findUnique.mockResolvedValue(null);

    await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/spreadsheets',
      payload: { spreadsheetUrl: URL_COMPLETA, label: 'Extra' },
    });

    expect(sheetsService.getColumnNames).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /dashboard/apis/:id/spreadsheets/:sheetId', () => {
  it('planilha que não pertence àquela API dá 404 e não apaga', async () => {
    // O `findFirst` filtra por `{ id: sheetId, sheetApiId: id }`: passar o
    // sheetId de outra API cai aqui, mesmo o usuário sendo dono da API do path.
    additionalSheetDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({
      method: 'DELETE',
      url: '/dashboard/apis/api-1/spreadsheets/add-de-outra-api',
    });

    expect(r.statusCode).toBe(404);
    expect(r.json().message).toBe('Additional spreadsheet not found.');
    expect(additionalSheetDb.delete).not.toHaveBeenCalled();

    expect(argDaChamada<{ where: Record<string, unknown> }>(additionalSheetDb.findFirst).where).toEqual({
      id: 'add-de-outra-api',
      sheetApiId: 'api-1',
    });
  });

  it('remove e devolve { deleted: true }', async () => {
    additionalSheetDb.findFirst.mockResolvedValue({
      id: 'add-1', sheetApiId: 'api-1', spreadsheetId: 'planilha-2', label: 'Banco',
    });

    const r = await app.inject({ method: 'DELETE', url: '/dashboard/apis/api-1/spreadsheets/add-1' });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ deleted: true });
    // O delete é por id puro — a posse já foi provada pelo findFirst acima.
    expect(argDaChamada<{ where: { id: string } }>(additionalSheetDb.delete).where).toEqual({ id: 'add-1' });
  });
});
