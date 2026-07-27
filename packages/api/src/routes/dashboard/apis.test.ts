/**
 * Testes de caracterização de `routes/dashboard/apis.ts`.
 *
 * Foco deliberado nas três garantias que, se quebrarem, viram falha de
 * segurança — e que hoje não tinham nenhum teste:
 *
 *   1. `GET /:id` NÃO devolve o plaintext das chaves (só `keyPrefix`).
 *      Antes do PR #118 devolvia a cada carregamento de página.
 *   2. `POST /:id/keys` devolve o plaintext UMA vez, grava bcrypt + prefixo,
 *      respeita `scopes` e sinaliza `apiIsPublic`.
 *   3. `PATCH /:id` faz dual-write: ao gravar bearerToken em texto, grava
 *      também o hash; ao apagar (null), zera os dois.
 *
 * Prisma, Google Sheets e o cache são mockados: o alvo é a lógica da rota.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import type { FastifyInstance } from 'fastify';

const sheetApiDb = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findMany: vi.fn(),
};
const apiKeyDb = { create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() };

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    sheetApi: sheetApiDb,
    apiKey: apiKeyDb,
    $transaction: vi.fn(),
  },
}));

vi.mock('../../services/google-sheets.service.js', () => ({
  getSpreadsheetMetadata: vi.fn().mockResolvedValue({ title: 'Planilha' }),
  getRows: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/sheet-api-cache.service.js', () => ({
  invalidateSheetApiCache: vi.fn().mockResolvedValue(undefined),
  findSheetApiCached: vi.fn(),
}));

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
const { dashboardApiRoutes } = await import('./apis.js');

let app: FastifyInstance;
const API = { id: 'api-1', slug: 'minha-api', userId: 'user-1', name: 'Minha API' };

beforeEach(async () => {
  vi.clearAllMocks();
  app = await montarApp({ rotas: dashboardApiRoutes, prefixo: '/dashboard/apis' });
});

describe('GET /dashboard/apis/:id — não pode vazar chave', () => {
  it('devolve keyPrefix e NUNCA o plaintext', async () => {
    sheetApiDb.findFirst.mockResolvedValue({
      ...API,
      apiKeys: [{
        id: 'k1', keyPrefix: 'abcd1234', label: 'claude', active: true,
        scopes: ['sheets:read'], expiresAt: null, lastUsedAt: null, createdAt: new Date(),
      }],
    });

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1' });

    expect(r.statusCode).toBe(200);
    const bruto = r.payload;
    expect(bruto).toContain('abcd1234');
    // A regressão que este teste existe para pegar: reintroduzir `key: true`
    // no select faria o plaintext voltar a sair aqui.
    expect(r.json().api.apiKeys[0].key).toBeUndefined();
    expect(r.json().api.apiKeys[0].keyHash).toBeUndefined();

    const select = argDaChamada<{ include: { apiKeys: { select: Record<string, unknown> } } }>(sheetApiDb.findFirst).include.apiKeys.select;
    expect(select.key).toBeUndefined();
    expect(select.keyPrefix).toBe(true);
  });

  it('API de outro dono dá 404', async () => {
    sheetApiDb.findFirst.mockResolvedValue(null);
    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-de-outro' });
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /dashboard/apis/:id/keys', () => {
  beforeEach(() => {
    sheetApiDb.findFirst.mockResolvedValue({ ...API, bearerToken: 'tok', bearerTokenHash: null, authEnabled: true });
    apiKeyDb.create.mockImplementation(async ({ data, select }) => ({
      id: 'k-novo',
      keyPrefix: data.keyPrefix,
      label: data.label,
      active: true,
      scopes: data.scopes,
      expiresAt: data.expiresAt,
      createdAt: new Date(),
      ...(select ? {} : {}),
    }));
  });

  it('devolve o plaintext uma vez e grava bcrypt + prefixo', async () => {
    const r = await app.inject({
      method: 'POST', url: '/dashboard/apis/api-1/keys',
      payload: { label: 'claude-julho' },
    });

    expect(r.statusCode).toBe(201);
    const plaintext = r.json().apiKey.key;
    expect(plaintext).toBeTruthy();

    const gravado = argDaChamada<{ data: { keyHash: string; keyPrefix: string } }>(apiKeyDb.create).data;
    expect(gravado.keyHash).not.toBe(plaintext);
    expect(await bcrypt.compare(plaintext, gravado.keyHash)).toBe(true);
    expect(gravado.keyPrefix).toBe(plaintext.slice(0, 8));
  });

  it('sem scopes concede os três (poder total)', async () => {
    await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/keys', payload: {} });
    expect(argDaChamada<{ data: { scopes: string[] } }>(apiKeyDb.create).data.scopes)
      .toEqual(['sheets:read', 'sheets:write', 'sheets:delete']);
  });

  it('respeita scopes restritos', async () => {
    await app.inject({
      method: 'POST', url: '/dashboard/apis/api-1/keys',
      payload: { scopes: ['sheets:read'] },
    });
    expect(argDaChamada<{ data: { scopes: string[] } }>(apiKeyDb.create).data.scopes).toEqual(['sheets:read']);
  });

  it('recusa escopo inventado', async () => {
    const r = await app.inject({
      method: 'POST', url: '/dashboard/apis/api-1/keys',
      payload: { scopes: ['sheets:tudo'] },
    });
    expect(r.statusCode).toBe(400);
    expect(apiKeyDb.create).not.toHaveBeenCalled();
  });

  it('avisa apiIsPublic quando a API não tem credencial', async () => {
    sheetApiDb.findFirst.mockResolvedValue({
      ...API, bearerToken: null, bearerTokenHash: null, basicUser: null, authEnabled: true,
    });
    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/keys', payload: {} });
    expect(r.json().apiIsPublic).toBe(true);
  });

  it('avisa apiIsPublic quando authEnabled está desligado, mesmo com bearer', async () => {
    sheetApiDb.findFirst.mockResolvedValue({
      ...API, bearerToken: 'tok', bearerTokenHash: 'hash', authEnabled: false,
    });
    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/keys', payload: {} });
    expect(r.json().apiIsPublic).toBe(true);
  });

  it('não marca apiIsPublic quando há bearer e auth ligado', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/keys', payload: {} });
    expect(r.json().apiIsPublic).toBe(false);
  });
});

describe('PATCH /dashboard/apis/:id — dual-write do bearer', () => {
  beforeEach(() => {
    sheetApiDb.findFirst.mockResolvedValue({ ...API });
    sheetApiDb.update.mockImplementation(async ({ data }) => ({ ...API, ...data }));
  });

  it('ao gravar bearerToken em texto, grava também o hash', async () => {
    const r = await app.inject({
      method: 'PATCH', url: '/dashboard/apis/api-1',
      payload: { bearerToken: 'token-novo-123' },
    });

    expect(r.statusCode).toBe(200);
    const data = argDaChamada<{ data: { bearerToken: string | null; bearerTokenHash: string | null } }>(sheetApiDb.update).data;
    expect(data.bearerToken).toBe('token-novo-123');
    expect(await bcrypt.compare('token-novo-123', data.bearerTokenHash!)).toBe(true);
  });

  it('ao apagar (null) zera token E hash — senão o hash antigo continuaria valendo', async () => {
    await app.inject({
      method: 'PATCH', url: '/dashboard/apis/api-1',
      payload: { bearerToken: null },
    });
    const data = argDaChamada<{ data: { bearerToken: string | null; bearerTokenHash: string | null } }>(sheetApiDb.update).data;
    expect(data.bearerToken).toBeNull();
    expect(data.bearerTokenHash).toBeNull();
  });

  it('aceita authEnabled', async () => {
    await app.inject({
      method: 'PATCH', url: '/dashboard/apis/api-1',
      payload: { authEnabled: false },
    });
    expect(argDaChamada<{ data: { authEnabled: boolean } }>(sheetApiDb.update).data.authEnabled).toBe(false);
  });

  it('recusa slug inválido', async () => {
    const r = await app.inject({
      method: 'PATCH', url: '/dashboard/apis/api-1',
      payload: { slug: 'Slug Com Espaço' },
    });
    expect(r.statusCode).toBe(400);
    expect(sheetApiDb.update).not.toHaveBeenCalled();
  });
});
