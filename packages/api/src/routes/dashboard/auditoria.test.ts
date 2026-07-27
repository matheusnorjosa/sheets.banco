/**
 * Testes da trilha de auditoria ligada às rotas do dashboard.
 *
 * Contexto: `services/audit.service.ts` existia inteiro — buffer, flush em
 * lote, corte em 50 entradas, hook de shutdown — e a função `audit()` **não
 * era chamada em lugar nenhum** do `src/`. A tabela `AuditLog` estava no
 * schema e vazia. Este arquivo cobre a ligação que faltava.
 *
 * Duas coisas são provadas aqui, e a segunda é a que importa mais:
 *
 *   1. Cada operação sensível gera a entrada certa, com ator, IP e user-agent.
 *   2. **Nenhum segredo entra na trilha.** Uma tabela de auditoria costuma ter
 *      retenção longa e acesso mais amplo que a tabela original; copiar
 *      credencial para dentro dela desfaria o trabalho do `secret-cipher`.
 *
 * O `audit.service` NÃO é mockado — seria mockar justamente o que se quer
 * provar. O que se mocka é o Prisma, e cada teste força o flush com
 * `flushAuditLog()` para inspecionar o que realmente chegaria ao banco.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const sheetApiDb = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findMany: vi.fn(),
};
const apiKeyDb = { create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn() };
const webhookDb = {
  findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), deleteMany: vi.fn(),
};
const auditLogCreateMany = vi.fn().mockResolvedValue({ count: 1 });

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    sheetApi: sheetApiDb,
    apiKey: apiKeyDb,
    webhookSubscription: webhookDb,
    webhookDelivery: { findMany: vi.fn() },
    auditLog: { createMany: auditLogCreateMany },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../services/google-sheets.service.js', () => ({
  getSpreadsheetMetadata: vi.fn().mockResolvedValue({ title: 'Planilha' }),
  getColumnNames: vi.fn().mockResolvedValue(['a', 'b']),
  getRows: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/sheet-api-cache.service.js', () => ({
  invalidateSheetApiCache: vi.fn().mockResolvedValue(undefined),
  findSheetApiCached: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', RATE_LIMIT_DASHBOARD_MAX: 10_000, RATE_LIMIT_DASHBOARD_WINDOW: '1 minute' },
}));

vi.mock('../../middleware/jwt-auth.js', () => ({
  jwtAuth: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' };
  },
}));

const { montarApp } = await import('../../test-utils/app.js');
const { flushAuditLog } = await import('../../services/audit.service.js');
const { dashboardApiRoutes } = await import('./apis.js');
const { webhookRoutes } = await import('./webhooks.js');

interface EntradaGravada {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  sheetApiId: string | null;
  changes?: Record<string, { old: unknown; new: unknown }>;
  ip: string | null;
  userAgent: string | null;
}

/** Força o flush e devolve o que chegaria ao `auditLog.createMany`. */
async function entradasGravadas(): Promise<EntradaGravada[]> {
  await flushAuditLog();
  return auditLogCreateMany.mock.calls.flatMap(
    (chamada) => (chamada[0] as { data: EntradaGravada[] }).data,
  );
}

/**
 * A primeira entrada gravada, com erro útil quando não houve nenhuma.
 *
 * Desestruturar (`const [entrada] = ...`) dá `T | undefined` sob
 * `noUncheckedIndexedAccess` e quebra o `tsc --noEmit`. Espalhar `!` pelo
 * arquivo esconderia o caso mais provável de falha — "a auditoria não foi
 * chamada" — atrás de um `Cannot read property of undefined`.
 */
async function primeiraEntrada(): Promise<EntradaGravada> {
  const entradas = await entradasGravadas();
  const primeira = entradas[0];
  if (!primeira) throw new Error('Nenhuma entrada de auditoria foi gravada.');
  return primeira;
}

const API = {
  id: 'api-1',
  slug: 'minha-api',
  name: 'Minha API',
  userId: 'user-1',
  spreadsheetId: 'planilha-1',
  authEnabled: true,
  bearerToken: 'TOKEN-ANTIGO-SUPER-SECRETO',
  bearerTokenHash: '$2b$10$hashantigohashantigo',
  basicUser: 'usuario',
  basicPass: 'SENHA-ANTIGA-SECRETA',
  hmacSecret: 'gcm$iv$ct$tag',
};

let app: FastifyInstance;
let appWebhooks: FastifyInstance;

beforeAll(() => {
  process.env.SECRETS_ENC_KEY = crypto.randomBytes(32).toString('hex');
});

beforeEach(async () => {
  vi.clearAllMocks();
  auditLogCreateMany.mockResolvedValue({ count: 1 });
  sheetApiDb.findFirst.mockResolvedValue({ ...API });
  sheetApiDb.create.mockResolvedValue({ ...API, id: 'api-nova' });
  sheetApiDb.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...API, ...data,
  }));
  apiKeyDb.create.mockResolvedValue({
    id: 'chave-1', keyPrefix: 'abcd1234', label: 'claude',
    active: true, scopes: ['sheets:read'], expiresAt: null, createdAt: new Date(),
  });
  apiKeyDb.findFirst.mockResolvedValue({ id: 'chave-1', sheetApiId: 'api-1', keyPrefix: 'abcd1234' });
  webhookDb.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'wh-1', active: true, createdAt: new Date(), ...data,
  }));
  webhookDb.deleteMany.mockResolvedValue({ count: 1 });

  app = await montarApp({ rotas: dashboardApiRoutes, prefixo: '/dashboard/apis' });
  appWebhooks = await montarApp({ rotas: webhookRoutes, prefixo: '/dashboard/apis' });
});

afterEach(async () => {
  // Drena o buffer e mata o setInterval — sem isso o estado de módulo vaza
  // entre testes e o vitest não encerra.
  await flushAuditLog();
});

describe('operações sensíveis geram entrada na trilha', () => {
  it('criar API → api.created', async () => {
    await app.inject({
      method: 'POST',
      url: '/dashboard/apis',
      payload: { name: 'Nova', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/abc123/edit' },
    });

    const entrada = await primeiraEntrada();
    expect(entrada).toMatchObject({
      action: 'api.created',
      resourceType: 'SheetApi',
      actorId: 'user-1',
    });
  });

  it('apagar chave de API → api_key.revoked com o prefixo, nunca a chave', async () => {
    await app.inject({ method: 'DELETE', url: '/dashboard/apis/api-1/keys/chave-1' });

    const entrada = await primeiraEntrada();
    expect(entrada.action).toBe('api_key.revoked');
    expect(entrada.resourceId).toBe('chave-1');
    expect(entrada.changes?.keyPrefix).toEqual({ old: 'abcd1234', new: null });
  });

  it('criar chave de API → api_key.created com escopos', async () => {
    await app.inject({
      method: 'POST', url: '/dashboard/apis/api-1/keys', payload: { scopes: ['sheets:read'] },
    });

    const entrada = await primeiraEntrada();
    expect(entrada.action).toBe('api_key.created');
    expect(entrada.changes?.scopes).toEqual({ old: null, new: ['sheets:read'] });
  });

  it('rotacionar bearer → api.bearer_rotated', async () => {
    await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/rotate-token' });

    const entrada = await primeiraEntrada();
    expect(entrada.action).toBe('api.bearer_rotated');
  });

  it('gerar segredo HMAC → api.hmac_rotated', async () => {
    await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/generate-hmac' });

    const entrada = await primeiraEntrada();
    expect(entrada.action).toBe('api.hmac_rotated');
  });

  it('criar webhook → webhook.created com url e eventos', async () => {
    await appWebhooks.inject({
      method: 'POST', url: '/dashboard/apis/api-1/webhooks',
      payload: { url: 'https://destino.test/hook', events: ['row.created'] },
    });

    const entrada = await primeiraEntrada();
    expect(entrada.action).toBe('webhook.created');
    expect(entrada.changes?.url).toEqual({ old: null, new: 'https://destino.test/hook' });
  });

  it('apagar webhook → webhook.deleted', async () => {
    await appWebhooks.inject({ method: 'DELETE', url: '/dashboard/apis/api-1/webhooks/wh-1' });

    const entrada = await primeiraEntrada();
    expect(entrada.action).toBe('webhook.deleted');
    expect(entrada.sheetApiId).toBe('api-1');
  });

  it('a entrada carrega ator, IP e user-agent — o "quem, de onde"', async () => {
    await app.inject({
      method: 'POST', url: '/dashboard/apis/api-1/rotate-token',
      headers: { 'user-agent': 'curl/8.4.0' },
      remoteAddress: '203.0.113.9',
    });

    const entrada = await primeiraEntrada();
    expect(entrada.actorId).toBe('user-1');
    expect(entrada.ip).toBe('203.0.113.9');
    expect(entrada.userAgent).toBe('curl/8.4.0');
  });

  it('operação de LEITURA não gera entrada — a trilha registra mudança, não acesso', async () => {
    sheetApiDb.findMany.mockResolvedValue([]);
    await app.inject({ method: 'GET', url: '/dashboard/apis' });

    expect(await entradasGravadas()).toHaveLength(0);
  });

  it('operação que FALHA não gera entrada', async () => {
    // A auditoria vem depois da escrita: 404 de posse não deixa rastro de
    // "mudou alguma coisa", porque nada mudou.
    sheetApiDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({ method: 'DELETE', url: '/dashboard/apis/api-de-outro/keys/k1' });

    expect(r.statusCode).toBe(404);
    expect(await entradasGravadas()).toHaveLength(0);
  });
});

describe('NENHUM segredo entra na trilha', () => {
  // Este é o bloco que justifica o arquivo. Uma trilha de auditoria tem
  // retenção longa e acesso mais amplo que a tabela original — se ela guardar
  // credencial, o `secret-cipher` deixa de valer.

  const SEGREDOS = [
    'TOKEN-ANTIGO-SUPER-SECRETO',
    '$2b$10$hashantigohashantigo',
    'SENHA-ANTIGA-SECRETA',
    'gcm$iv$ct$tag',
  ];

  /** Serializa TUDO que foi gravado e procura por qualquer segredo dentro. */
  async function trilhaSerializada(): Promise<string> {
    return JSON.stringify(await entradasGravadas());
  }

  it('PATCH gravando bearer novo registra só a PRESENÇA, não o valor', async () => {
    await app.inject({
      method: 'PATCH', url: '/dashboard/apis/api-1',
      payload: { bearerToken: 'TOKEN-NOVINHO-EM-FOLHA' },
    });

    const trilha = await trilhaSerializada();

    expect(trilha).not.toContain('TOKEN-NOVINHO-EM-FOLHA');
    expect(trilha).not.toContain('TOKEN-ANTIGO-SUPER-SECRETO');
    // O que fica registrado é que o campo passou a existir — o suficiente para
    // uma investigação, sem copiar a credencial.
    expect(trilha).toContain('[definido]');
  });

  it('PATCH apagando o bearer registra a transição para ausente', async () => {
    await app.inject({
      method: 'PATCH', url: '/dashboard/apis/api-1', payload: { bearerToken: null },
    });

    const entrada = await primeiraEntrada();
    expect(entrada.changes?.bearerToken).toEqual({ old: '[definido]', new: '[ausente]' });
    // O hash acompanha o dual-write e também é redigido.
    expect(entrada.changes?.bearerTokenHash).toEqual({ old: '[definido]', new: '[ausente]' });
  });

  it('rotação de bearer não deixa o token na trilha', async () => {
    await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/rotate-token' });
    const trilha = await trilhaSerializada();

    for (const segredo of SEGREDOS) expect(trilha).not.toContain(segredo);
  });

  it('geração de HMAC não deixa o segredo na trilha', async () => {
    await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/generate-hmac' });
    const trilha = await trilhaSerializada();

    expect(trilha).not.toContain('gcm$');
    for (const segredo of SEGREDOS) expect(trilha).not.toContain(segredo);
  });

  it('criação de chave não deixa o plaintext nem o hash na trilha', async () => {
    const r = await app.inject({ method: 'POST', url: '/dashboard/apis/api-1/keys', payload: {} });
    const plaintext: string = r.json().apiKey.key;
    const trilha = await trilhaSerializada();

    expect(plaintext).toBeTruthy();
    expect(trilha).not.toContain(plaintext);
    expect(trilha).not.toContain('keyHash');
  });

  it('criação de webhook não deixa o segredo na trilha', async () => {
    const r = await appWebhooks.inject({
      method: 'POST', url: '/dashboard/apis/api-1/webhooks',
      payload: { url: 'https://destino.test/hook', events: ['row.created'] },
    });
    const segredo: string = r.json().webhook.secret;
    const trilha = await trilhaSerializada();

    expect(segredo).toBeTruthy();
    expect(trilha).not.toContain(segredo);
    expect(trilha).not.toContain('gcm$');
  });

  it('mas campo NÃO sensível é registrado com o valor — senão a trilha não serve', async () => {
    // O contraponto necessário: se tudo fosse redigido, os testes acima não
    // distinguiriam "redige segredo" de "não registra nada".
    await app.inject({
      method: 'PATCH', url: '/dashboard/apis/api-1', payload: { authEnabled: false },
    });

    const entrada = await primeiraEntrada();
    expect(entrada.changes?.authEnabled).toEqual({ old: true, new: false });
  });
});
