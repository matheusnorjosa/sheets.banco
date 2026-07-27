/**
 * Testes de caracterização de `routes/dashboard/webhooks.ts`.
 *
 * Por que este arquivo merece teste (estava com 0% de cobertura):
 *
 *   1. O `secret` do webhook é a credencial que o consumidor usa para conferir
 *      a assinatura HMAC dos nossos POSTs. Ele sai em **texto claro uma única
 *      vez** (na resposta do POST) e é gravado **criptografado** (envelope
 *      `gcm$`). Se alguém trocar `encrypt(secretPlain)` por `secretPlain`, a
 *      rota continua respondendo 201 e ninguém percebe — a não ser este teste.
 *   2. Toda rota aqui é dona-dependente: sem `sheetApi.findFirst` casando
 *      `{ id, userId }`, é 404. É a única barreira entre webhooks de contas
 *      diferentes.
 *
 * Por isso o `secret-cipher` NÃO é mockado: mockar a cifra faria o teste passar
 * com a criptografia quebrada. Usamos a cifra real com uma chave de teste e
 * provamos com `isEncrypted()` + `decrypt()`.
 *
 * Prisma e o jwtAuth são mockados: o alvo é a lógica da rota.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const sheetApiDb = { findFirst: vi.fn() };
const webhookDb = {
  findMany: vi.fn(),
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};
const deliveryDb = { findMany: vi.fn() };

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    sheetApi: sheetApiDb,
    webhookSubscription: webhookDb,
    webhookDelivery: deliveryDb,
  },
}));

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test' },
}));

// jwtAuth real exigiria montar o plugin inteiro; as rotas só consomem
// `request.user.sub`.
vi.mock('../../middleware/jwt-auth.js', () => ({
  jwtAuth: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' };
  },
}));

const { montarApp, argDaChamada } = await import('../../test-utils/app.js');
const { isEncrypted, decrypt } = await import('../../lib/secret-cipher.js');
const { webhookRoutes } = await import('./webhooks.js');

let app: FastifyInstance;

const API = { id: 'api-1', slug: 'minha-api', userId: 'user-1', name: 'Minha API' };
const URL_OK = 'https://exemplo.com/hook';

beforeAll(() => {
  // Chave só do teste — a cifra roda de verdade. NUNCA um segredo real.
  process.env.SECRETS_ENC_KEY = crypto.randomBytes(32).toString('hex');
});

beforeEach(async () => {
  vi.clearAllMocks();
  sheetApiDb.findFirst.mockResolvedValue({ ...API });
  webhookDb.findMany.mockResolvedValue([]);
  webhookDb.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'wh-novo',
    active: true,
    createdAt: new Date('2026-07-27T12:00:00.000Z'),
    ...data,
  }));
  webhookDb.findFirst.mockResolvedValue({ id: 'wh-1', sheetApiId: 'api-1' });
  webhookDb.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'wh-1',
    sheetApiId: 'api-1',
    url: URL_OK,
    events: ['row.created'],
    active: true,
    ...data,
  }));
  webhookDb.deleteMany.mockResolvedValue({ count: 1 });
  deliveryDb.findMany.mockResolvedValue([]);
  app = await montarApp({ rotas: webhookRoutes, prefixo: '/dashboard/apis' });
});

/** Atalho para o POST de criação com corpo válido. */
function criar(payload: Record<string, unknown> = { url: URL_OK, events: ['row.created'] }) {
  return app.inject({ method: 'POST', url: '/dashboard/apis/api-1/webhooks', payload });
}

describe('POST /dashboard/apis/:id/webhooks — segredo em claro uma vez, cifrado no banco', () => {
  it('devolve o plaintext na resposta e grava o envelope gcm$ que decifra nele', async () => {
    const r = await criar();

    expect(r.statusCode).toBe(201);
    const plaintext: string = r.json().webhook.secret;
    expect(plaintext).toBeTruthy();

    const gravado = argDaChamada<{ data: { secret: string } }>(webhookDb.create).data.secret;

    // O que este teste existe para pegar: trocar `encrypt(secretPlain)` por
    // `secretPlain` no create deixaria o segredo em texto puro no banco e a
    // rota continuaria devolvendo 201.
    expect(gravado).not.toBe(plaintext);
    expect(isEncrypted(gravado)).toBe(true);
    expect(gravado.startsWith('gcm$')).toBe(true);
    expect(decrypt(gravado)).toBe(plaintext);
  });

  it('o segredo tem 64 chars hex (32 bytes) e muda a cada criação', async () => {
    const a = await criar();
    const b = await criar();

    const secretA: string = a.json().webhook.secret;
    const secretB: string = b.json().webhook.secret;

    expect(secretA).toMatch(/^[0-9a-f]{64}$/);
    expect(secretB).toMatch(/^[0-9a-f]{64}$/);
    expect(secretA).not.toBe(secretB);

    // E os dois envelopes gravados também diferem (IV aleatório por chamada).
    const envelopeA = argDaChamada<{ data: { secret: string } }>(webhookDb.create, 0).data.secret;
    const envelopeB = argDaChamada<{ data: { secret: string } }>(webhookDb.create, 1).data.secret;
    expect(envelopeA).not.toBe(envelopeB);
    expect(decrypt(envelopeA)).toBe(secretA);
    expect(decrypt(envelopeB)).toBe(secretB);
  });

  it('grava sheetApiId, url e events vindos do parâmetro/corpo', async () => {
    await criar({ url: URL_OK, events: ['row.updated', 'rows.cleared'] });

    const data = argDaChamada<{ data: { sheetApiId: string; url: string; events: string[] } }>(webhookDb.create).data;
    expect(data.sheetApiId).toBe('api-1');
    expect(data.url).toBe(URL_OK);
    expect(data.events).toEqual(['row.updated', 'rows.cleared']);
  });
});

describe('posse: sem SheetApi do usuário, tudo é 404', () => {
  const rotas: Array<{ metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }> = [
    { metodo: 'GET', url: '/dashboard/apis/api-de-outro/webhooks' },
    { metodo: 'POST', url: '/dashboard/apis/api-de-outro/webhooks' },
    { metodo: 'PATCH', url: '/dashboard/apis/api-de-outro/webhooks/wh-1' },
    { metodo: 'DELETE', url: '/dashboard/apis/api-de-outro/webhooks/wh-1' },
    { metodo: 'GET', url: '/dashboard/apis/api-de-outro/webhooks/wh-1/deliveries' },
  ];

  it.each(rotas)('$metodo $url → 404', async ({ metodo, url }) => {
    sheetApiDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({
      method: metodo,
      url,
      ...(metodo === 'POST' || metodo === 'PATCH'
        ? { payload: { url: URL_OK, events: ['row.created'] } }
        : {}),
    });

    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('NOT_FOUND');
    // A checagem de posse vem ANTES de qualquer escrita.
    expect(webhookDb.create).not.toHaveBeenCalled();
    expect(webhookDb.update).not.toHaveBeenCalled();
    expect(webhookDb.deleteMany).not.toHaveBeenCalled();
  });

  it('a consulta de posse casa id + userId (não só id)', async () => {
    await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/webhooks' });
    const where = argDaChamada<{ where: { id: string; userId: string } }>(sheetApiDb.findFirst).where;
    expect(where).toEqual({ id: 'api-1', userId: 'user-1' });
  });
});

describe('POST — validação do corpo (nada é gravado quando falha)', () => {
  it.each([
    ['url que não é URL', { url: 'nao-e-uma-url', events: ['row.created'] }],
    ['events vazio', { url: URL_OK, events: [] }],
    ['evento inválido', { url: URL_OK, events: ['row.explodiu'] }],
    ['sem url', { events: ['row.created'] }],
  ])('%s → 400 e não chama create', async (_nome, payload) => {
    const r = await criar(payload as Record<string, unknown>);

    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('VALIDATION_ERROR');
    expect(webhookDb.create).not.toHaveBeenCalled();
  });

  it.each(['row.created', 'row.updated', 'row.deleted', 'rows.cleared'])(
    'aceita o evento %s',
    async (evento) => {
      const r = await criar({ url: URL_OK, events: [evento] });
      expect(r.statusCode).toBe(201);
    },
  );
});

describe('GET /dashboard/apis/:id/webhooks — listagem', () => {
  it('ordena por createdAt desc e inclui a contagem de deliveries', async () => {
    webhookDb.findMany.mockResolvedValue([
      { id: 'wh-1', url: URL_OK, events: ['row.created'], active: true, _count: { deliveries: 7 } },
    ]);

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/webhooks' });

    expect(r.statusCode).toBe(200);
    expect(r.json().webhooks[0]._count.deliveries).toBe(7);

    const consulta = argDaChamada<{
      where: { sheetApiId: string };
      orderBy: { createdAt: string };
      include: { _count: { select: { deliveries: boolean } } };
    }>(webhookDb.findMany);
    expect(consulta.where).toEqual({ sheetApiId: 'api-1' });
    expect(consulta.orderBy).toEqual({ createdAt: 'desc' });
    expect(consulta.include._count.select.deliveries).toBe(true);
  });

  it('devolve `webhooks: []` quando não há nenhum (não 404)', async () => {
    webhookDb.findMany.mockResolvedValue([]);
    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/webhooks' });
    expect(r.statusCode).toBe(200);
    expect(r.json().webhooks).toEqual([]);
  });

  it('a listagem NÃO decifra o segredo — devolve o que o banco tem', async () => {
    // Documenta o contrato: o plaintext só existe na resposta do POST. Aqui
    // sai o envelope cru, que é inútil para quem não tem a chave.
    const envelope = 'gcm$aaa$bbb$ccc';
    webhookDb.findMany.mockResolvedValue([{ id: 'wh-1', url: URL_OK, secret: envelope }]);

    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/webhooks' });

    expect(r.json().webhooks[0].secret).toBe(envelope);
  });
});

describe('PATCH /dashboard/apis/:id/webhooks/:webhookId', () => {
  it('webhook de outra API → 404 (o findFirst amarra webhookId + sheetApiId)', async () => {
    webhookDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/webhooks/wh-de-outra-api',
      payload: { active: false },
    });

    expect(r.statusCode).toBe(404);
    expect(r.json().message).toBe('Webhook not found.');
    expect(argDaChamada<{ where: Record<string, string> }>(webhookDb.findFirst).where)
      .toEqual({ id: 'wh-de-outra-api', sheetApiId: 'api-1' });
    expect(webhookDb.update).not.toHaveBeenCalled();
  });

  it('active: false chega no update', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/webhooks/wh-1',
      payload: { active: false },
    });

    expect(r.statusCode).toBe(200);
    const chamada = argDaChamada<{ where: { id: string }; data: { active: boolean } }>(webhookDb.update);
    expect(chamada.where).toEqual({ id: 'wh-1' });
    expect(chamada.data).toEqual({ active: false });
    expect(r.json().webhook.active).toBe(false);
  });

  it('url inválida → 400 e nada é atualizado', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/webhooks/wh-1',
      payload: { url: 'nao-e-url' },
    });

    expect(r.statusCode).toBe(400);
    expect(webhookDb.update).not.toHaveBeenCalled();
  });

  it('corpo vazio passa e chama update com data vazio (todos os campos são opcionais)', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/webhooks/wh-1',
      payload: {},
    });

    expect(r.statusCode).toBe(200);
    expect(argDaChamada<{ data: Record<string, unknown> }>(webhookDb.update).data).toEqual({});
  });

  it('campo desconhecido é descartado pelo zod, não vira 400', async () => {
    // Em especial `secret`: não há rota para trocar o segredo — a rotação é
    // deletar + criar. Um PATCH com `secret` responde 200 e ignora o campo.
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/webhooks/wh-1',
      payload: { active: true, secret: 'tentando-injetar', sheetApiId: 'api-de-outro' },
    });

    expect(r.statusCode).toBe(200);
    expect(argDaChamada<{ data: Record<string, unknown> }>(webhookDb.update).data).toEqual({ active: true });
  });
});

describe('DELETE /dashboard/apis/:id/webhooks/:webhookId', () => {
  it('apaga e responde { deleted: true }', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/dashboard/apis/api-1/webhooks/wh-1' });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ deleted: true });
  });

  it('amarra a exclusão em (id, sheetApiId) — não apaga webhook de outra API', async () => {
    // Este é o teste que fecha o furo de posse. Antes, a rota chamava
    // `delete({ where: { id: webhookId } })`: a checagem de posse cobria só a
    // SheetApi da URL, então bastava ser dono de QUALQUER API para apagar o
    // webhook de outra — inclusive de outro usuário — sabendo o id.
    //
    // Se alguém reintroduzir o `delete` por id, o `where` deixa de ter
    // `sheetApiId` e este teste falha.
    await app.inject({ method: 'DELETE', url: '/dashboard/apis/api-1/webhooks/wh-1' });

    const where = argDaChamada<{ where: Record<string, unknown> }>(webhookDb.deleteMany).where;
    expect(where).toEqual({ id: 'wh-1', sheetApiId: 'api-1' });
  });

  it('webhook de outra API → 404, e nada é apagado', async () => {
    // `deleteMany` com um par que não existe devolve `count: 0`; a rota traduz
    // isso em 404 em vez de responder `{ deleted: true }` para uma exclusão
    // que não aconteceu.
    webhookDb.deleteMany.mockResolvedValue({ count: 0 });

    const r = await app.inject({
      method: 'DELETE',
      url: '/dashboard/apis/api-1/webhooks/wh-de-outra-api',
    });

    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('NOT_FOUND');
  });

  it('webhook já apagado também dá 404, não 500', async () => {
    // Ganho colateral da troca de `delete` por `deleteMany`: o `delete` do
    // Prisma estoura P2025 quando o registro não existe, e a rota não trata —
    // virava 500. Agora é `count: 0` → 404.
    webhookDb.deleteMany.mockResolvedValue({ count: 0 });

    const r = await app.inject({ method: 'DELETE', url: '/dashboard/apis/api-1/webhooks/wh-1' });

    expect(r.statusCode).toBe(404);
  });
});

describe('GET /dashboard/apis/:id/webhooks/:webhookId/deliveries', () => {
  it('limita a 50 e ordena por createdAt desc', async () => {
    deliveryDb.findMany.mockResolvedValue([
      { id: 'd1', event: 'row.created', status: 'success', responseCode: 200 },
    ]);

    const r = await app.inject({
      method: 'GET',
      url: '/dashboard/apis/api-1/webhooks/wh-1/deliveries',
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().deliveries).toHaveLength(1);

    const consulta = argDaChamada<{
      where: { subscriptionId: string };
      orderBy: { createdAt: string };
      take: number;
    }>(deliveryDb.findMany);
    expect(consulta.where).toEqual({ subscriptionId: 'wh-1' });
    expect(consulta.orderBy).toEqual({ createdAt: 'desc' });
    expect(consulta.take).toBe(50);
  });

  it('confere que o webhook é daquela API antes de ler o histórico', async () => {
    await app.inject({
      method: 'GET',
      url: '/dashboard/apis/api-1/webhooks/wh-1/deliveries',
    });

    expect(argDaChamada<{ where: Record<string, unknown> }>(webhookDb.findFirst).where)
      .toEqual({ id: 'wh-1', sheetApiId: 'api-1' });
  });

  it('webhook de outra API → 404, e o histórico NÃO é lido', async () => {
    // O vazamento que este teste fecha não é abstrato: o `payload` de cada
    // delivery carrega os dados das linhas da planilha que dispararam o
    // evento. Sem a amarração, qualquer dono de API lia o histórico de
    // qualquer webhook sabendo o id da subscription.
    webhookDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({
      method: 'GET',
      url: '/dashboard/apis/api-1/webhooks/wh-de-outra-api/deliveries',
    });

    expect(r.statusCode).toBe(404);
    expect(deliveryDb.findMany).not.toHaveBeenCalled();
  });
});
