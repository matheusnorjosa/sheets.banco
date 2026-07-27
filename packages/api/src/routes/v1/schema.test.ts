/**
 * Testes de caracterização de `routes/v1/schema.ts` — introspecção.
 *
 * Por que este arquivo merece teste apesar de ser "só leitura": as três rotas
 * (`/schema`, `/openapi.json`, `/postman.json`) são **100% públicas** — não
 * passam por `apiAuth`, `apiCors` nem IP whitelist. É a única superfície da
 * API que responde sem credencial nenhuma.
 *
 * Consequência: o que sai daqui é visível para qualquer um que tenha o apiId.
 * O teste trava (a) que a inferência de tipo não muda sem querer, e (b) que
 * nenhum segredo da SheetApi vaza no spec gerado.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const sheetsService = {
  getRows: vi.fn().mockResolvedValue([]),
  // `getColumnNames` alimenta o openapi.json e o postman.json. Sem ela no
  // mock as duas rotas dão 500 — o que, na primeira rodada, foi exatamente o
  // que aconteceu.
  getColumnNames: vi.fn().mockResolvedValue(['nome', 'idade']),
};
vi.mock('../../services/google-sheets.service.js', () => sheetsService);

const sheetApiDb = { findUnique: vi.fn(), findFirst: vi.fn() };
vi.mock('../../lib/prisma.js', () => ({ prisma: { sheetApi: sheetApiDb } }));

vi.mock('../../config/env.js', () => ({
  env: { RATE_LIMIT_MAX: 10000, RATE_LIMIT_WINDOW: '1 minute' },
}));

const { montarApp } = await import('../../test-utils/app.js');
const { schemaRoutes } = await import('./schema.js');

let app: FastifyInstance;

/** SheetApi com segredos preenchidos — para provar que nenhum vaza no spec. */
const API_COM_SEGREDOS = {
  id: 'api-1',
  name: 'Minha API',
  slug: 'minha-api',
  spreadsheetId: 'planilha-abc',
  userId: 'user-1',
  allowRead: true,
  allowCreate: true,
  allowUpdate: true,
  allowDelete: true,
  bearerToken: 'TOKEN-SUPER-SECRETO-NAO-PODE-VAZAR',
  bearerTokenHash: '$2b$10$hashsecretohashsecreto',
  basicUser: 'usuario-secreto',
  basicPass: 'senha-secreta',
  hmacSecret: 'gcm$iv$ct$tag',
};

beforeEach(async () => {
  vi.clearAllMocks();
  sheetApiDb.findUnique.mockResolvedValue(API_COM_SEGREDOS);
  sheetsService.getRows.mockResolvedValue([]);
  sheetsService.getColumnNames.mockResolvedValue(['nome', 'idade']);
  app = await montarApp({ rotas: schemaRoutes, prefixo: '/api/v1' });
});

describe('GET /:apiId/schema — inferência de tipo', () => {
  it('infere number quando todos os valores são numéricos', async () => {
    sheetsService.getRows.mockResolvedValue([{ idade: '30' }, { idade: '45' }]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/schema' });

    expect(r.statusCode).toBe(200);
    const col = r.json().columns.find((c: { name: string }) => c.name === 'idade');
    expect(col.type).toBe('number');
  });

  it('infere boolean só com true/false literais', async () => {
    sheetsService.getRows.mockResolvedValue([{ ativo: 'true' }, { ativo: 'false' }]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/schema' });
    expect(r.json().columns.find((c: { name: string }) => c.name === 'ativo').type).toBe('boolean');
  });

  it('cai para string quando mistura número e texto', async () => {
    sheetsService.getRows.mockResolvedValue([{ cod: '123' }, { cod: 'ABC' }]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/schema' });
    expect(r.json().columns.find((c: { name: string }) => c.name === 'cod').type).toBe('string');
  });

  it('coluna toda vazia vira string, não quebra', async () => {
    sheetsService.getRows.mockResolvedValue([{ obs: '' }, { obs: '' }]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/schema' });
    expect(r.json().columns.find((c: { name: string }) => c.name === 'obs').type).toBe('string');
  });

  it('planilha VAZIA devolve formato diferente — só columns, sem sampleSize/totalRows', async () => {
    // Divergência de contrato que vale conhecer: com linhas, a resposta é
    // `{ columns, sampleSize, totalRows }`; sem linhas, é só `{ columns }`,
    // e os tipos vêm todos como 'string' (não há valor para inferir). Um
    // cliente que leia `totalRows` direto quebra com planilha vazia.
    sheetsService.getRows.mockResolvedValue([]);
    sheetsService.getColumnNames.mockResolvedValue(['nome', 'cpf']);

    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/schema' });

    expect(r.statusCode).toBe(200);
    const corpo = r.json();
    expect(corpo.columns).toEqual([
      { name: 'nome', type: 'string' },
      { name: 'cpf', type: 'string' },
    ]);
    expect(corpo.totalRows).toBeUndefined();
    expect(corpo.sampleSize).toBeUndefined();
  });

  it('com linhas, devolve sampleSize e totalRows (amostra limitada a 100)', async () => {
    const muitas = Array.from({ length: 250 }, (_, i) => ({ n: String(i) }));
    sheetsService.getRows.mockResolvedValue(muitas);

    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/schema' });

    expect(r.json().totalRows).toBe(250);
    expect(r.json().sampleSize).toBe(100); // o tipo é inferido de 100 linhas, não de 250
  });

  it('apiId inexistente dá 404', async () => {
    sheetApiDb.findUnique.mockResolvedValue(null);
    sheetApiDb.findFirst.mockResolvedValue(null);
    const r = await app.inject({ method: 'GET', url: '/api/v1/nao-existe/schema' });
    expect(r.statusCode).toBe(404);
  });
});

describe('rotas públicas NÃO podem vazar segredo', () => {
  // Estas três rotas respondem sem nenhuma credencial. Se um refactor
  // acidentalmente serializar o registro inteiro da SheetApi, o bearerToken
  // de produção fica exposto para quem tiver o apiId — que é justamente o
  // cenário que o rollout do Bearer existiu para fechar.
  const segredos = [
    'TOKEN-SUPER-SECRETO-NAO-PODE-VAZAR',
    '$2b$10$hashsecretohashsecreto',
    'usuario-secreto',
    'senha-secreta',
    'gcm$iv$ct$tag',
  ];

  it.each(['/schema', '/openapi.json', '/postman.json'])(
    '%s não contém credencial nenhuma no corpo',
    async (rota) => {
      sheetsService.getRows.mockResolvedValue([{ nome: 'Ana', idade: '30' }]);
      const r = await app.inject({ method: 'GET', url: `/api/v1/api-1${rota}` });

      expect(r.statusCode).toBe(200);
      for (const segredo of segredos) {
        expect(r.payload).not.toContain(segredo);
      }
      // Nomes de campo também não podem aparecer — se aparecerem, é sinal de
      // que o objeto inteiro foi serializado.
      expect(r.payload).not.toContain('bearerToken');
      expect(r.payload).not.toContain('basicPass');
      expect(r.payload).not.toContain('hmacSecret');
    },
  );
});

describe('GET /:apiId/openapi.json', () => {
  it('gera spec OpenAPI 3 válido no essencial', async () => {
    sheetsService.getRows.mockResolvedValue([{ nome: 'Ana' }]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/openapi.json' });

    expect(r.statusCode).toBe(200);
    const spec = r.json();
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info).toBeTruthy();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });
});

describe('GET /:apiId/postman.json', () => {
  it('gera coleção Postman v2.1', async () => {
    sheetsService.getRows.mockResolvedValue([{ nome: 'Ana' }]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/postman.json' });

    expect(r.statusCode).toBe(200);
    const col = r.json();
    expect(col.info.schema).toContain('v2.1.0');
    expect(Array.isArray(col.item)).toBe(true);
  });
});
