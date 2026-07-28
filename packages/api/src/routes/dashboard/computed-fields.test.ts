/**
 * Testes de caracterização de `routes/dashboard/computed-fields.ts`.
 *
 * Por que este arquivo merece teste (estava com 0% de cobertura):
 *
 *   1. **Posse.** As quatro rotas dependem de um único `sheetApi.findFirst`
 *      com `{ id, userId }` para negar acesso à API de outro dono. É a única
 *      barreira: se ela cair, qualquer usuário logado lê/edita/apaga os campos
 *      calculados de qualquer API.
 *   2. **Nome é contrato, não enfeite.** O `applyComputedFields`
 *      (`utils/computed-fields.ts`) resolve templates com `/\{\{(\w+)\}\}/g`.
 *      Um nome fora de `\w+` nunca poderia ser referenciado — daí o regex
 *      `^\w+$` no POST. O teste trava esse limite.
 *   3. **Assimetria POST × PATCH.** O POST valida com Zod (`min/max/regex`);
 *      o PATCH só checa "existe e não é vazia". Isso está documentado abaixo
 *      com um teste explícito — comportamento de HOJE, não endosso.
 *
 * Prisma e `jwtAuth` são mockados: o alvo é a lógica da rota, exercitada de
 * ponta a ponta com `app.inject()` (hooks + error handler reais).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const sheetApiDb = { findFirst: vi.fn() };
const computedFieldDb = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    sheetApi: sheetApiDb,
    computedField: computedFieldDb,
  },
}));

// `config/env.js` valida o ambiente na importação e explode sem DATABASE_URL.
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
const { computedFieldRoutes } = await import('./computed-fields.js');

let app: FastifyInstance;

const API = { id: 'api-1', slug: 'minha-api', userId: 'user-1', name: 'Minha API' };
const CAMPO = {
  id: 'campo-1',
  sheetApiId: 'api-1',
  name: 'total',
  expression: '{{preco}} * {{qtd}}',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(async () => {
  vi.clearAllMocks();
  sheetApiDb.findFirst.mockResolvedValue(API);
  computedFieldDb.findMany.mockResolvedValue([CAMPO]);
  computedFieldDb.findUnique.mockResolvedValue(null);
  computedFieldDb.findFirst.mockResolvedValue(CAMPO);
  computedFieldDb.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'campo-novo',
    createdAt: new Date('2026-02-02T00:00:00Z'),
    ...data,
  }));
  computedFieldDb.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...CAMPO,
    ...data,
  }));
  computedFieldDb.delete.mockResolvedValue(CAMPO);
  app = await montarApp({ rotas: computedFieldRoutes, prefixo: '/dashboard/apis' });
});

describe('posse da API — a única barreira das quatro rotas', () => {
  // Se `sheetApi.findFirst({ id, userId })` não achar, nenhuma rota chega a
  // tocar em `computedField`. Este it.each é o teste de regressão de IDOR.
  const rotas = [
    { rotulo: 'GET (listar)', metodo: 'GET' as const, url: '/dashboard/apis/api-de-outro/computed-fields' },
    { rotulo: 'POST (criar)', metodo: 'POST' as const, url: '/dashboard/apis/api-de-outro/computed-fields' },
    { rotulo: 'PATCH (editar)', metodo: 'PATCH' as const, url: '/dashboard/apis/api-de-outro/computed-fields/campo-1' },
    { rotulo: 'DELETE (apagar)', metodo: 'DELETE' as const, url: '/dashboard/apis/api-de-outro/computed-fields/campo-1' },
  ];

  it.each(rotas)('$rotulo em API de outro dono dá 404', async ({ metodo, url }) => {
    sheetApiDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({
      method: metodo,
      url,
      payload: { name: 'total', expression: '1+1' },
    });

    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('NOT_FOUND');
    // Nenhuma escrita nem leitura de campo acontece antes da checagem de posse.
    expect(computedFieldDb.findMany).not.toHaveBeenCalled();
    expect(computedFieldDb.create).not.toHaveBeenCalled();
    expect(computedFieldDb.update).not.toHaveBeenCalled();
    expect(computedFieldDb.delete).not.toHaveBeenCalled();
  });

  it('a busca de posse filtra por id E userId (não só por id)', async () => {
    await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/computed-fields' });

    expect(argDaChamada<{ where: { id: string; userId: string } }>(sheetApiDb.findFirst).where)
      .toEqual({ id: 'api-1', userId: 'user-1' });
  });
});

describe('GET /dashboard/apis/:id/computed-fields', () => {
  it('lista os campos da API em ordem de criação', async () => {
    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/computed-fields' });

    expect(r.statusCode).toBe(200);
    expect(r.json().fields).toHaveLength(1);
    expect(r.json().fields[0].name).toBe('total');

    const consulta = argDaChamada<{
      where: { sheetApiId: string };
      orderBy: { createdAt: string };
    }>(computedFieldDb.findMany);
    expect(consulta.where).toEqual({ sheetApiId: 'api-1' });
    expect(consulta.orderBy).toEqual({ createdAt: 'asc' });
  });
});

describe('POST /dashboard/apis/:id/computed-fields — criação', () => {
  it('corpo válido devolve 201 com o campo criado', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/computed-fields',
      payload: { name: 'total', expression: '{{preco}} * {{qtd}}' },
    });

    expect(r.statusCode).toBe(201);
    expect(r.json().field).toMatchObject({
      id: 'campo-novo',
      sheetApiId: 'api-1',
      name: 'total',
      expression: '{{preco}} * {{qtd}}',
    });

    expect(argDaChamada<{ data: Record<string, unknown> }>(computedFieldDb.create).data).toEqual({
      sheetApiId: 'api-1',
      name: 'total',
      expression: '{{preco}} * {{qtd}}',
    });
  });

  describe('validação do name (regex ^\\w+$)', () => {
    // O `\w` do JS = [A-Za-z0-9_]. Hífen e espaço estão fora, e é isso que
    // impede um nome que o `applyComputedFields` jamais conseguiria casar.
    it.each([
      ['hífen', 'meu-campo'],
      ['espaço', 'meu campo'],
      ['ponto', 'meu.campo'],
      ['vazio', ''],
      ['51 caracteres', 'a'.repeat(51)],
    ])('recusa nome com %s → 400', async (_rotulo, name) => {
      const r = await app.inject({
        method: 'POST',
        url: '/dashboard/apis/api-1/computed-fields',
        payload: { name, expression: '1+1' },
      });

      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe('VALIDATION_ERROR');
      expect(computedFieldDb.create).not.toHaveBeenCalled();
      // A checagem de duplicidade nem roda: a validação vem antes.
      expect(computedFieldDb.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ['underscores e dígitos', 'meu_campo_1'],
      ['só underscore', '_'],
      ['exatamente 50 caracteres', 'a'.repeat(50)],
    ])('aceita nome com %s → 201', async (_rotulo, name) => {
      const r = await app.inject({
        method: 'POST',
        url: '/dashboard/apis/api-1/computed-fields',
        payload: { name, expression: '1+1' },
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().field.name).toBe(name);
    });
  });

  describe('validação da expression (1..500)', () => {
    it('expression vazia → 400', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/dashboard/apis/api-1/computed-fields',
        payload: { name: 'total', expression: '' },
      });

      expect(r.statusCode).toBe(400);
      expect(computedFieldDb.create).not.toHaveBeenCalled();
    });

    it('expression com 501 caracteres → 400', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/dashboard/apis/api-1/computed-fields',
        payload: { name: 'total', expression: 'x'.repeat(501) },
      });

      expect(r.statusCode).toBe(400);
      expect(computedFieldDb.create).not.toHaveBeenCalled();
    });

    it('expression com exatamente 500 caracteres → 201', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/dashboard/apis/api-1/computed-fields',
        payload: { name: 'total', expression: 'x'.repeat(500) },
      });

      expect(r.statusCode).toBe(201);
    });

    it('corpo sem expression → 400', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/dashboard/apis/api-1/computed-fields',
        payload: { name: 'total' },
      });

      expect(r.statusCode).toBe(400);
      expect(computedFieldDb.create).not.toHaveBeenCalled();
    });
  });

  describe('nome duplicado', () => {
    it('recusa com 400 e não chama create', async () => {
      computedFieldDb.findUnique.mockResolvedValue(CAMPO);

      const r = await app.inject({
        method: 'POST',
        url: '/dashboard/apis/api-1/computed-fields',
        payload: { name: 'total', expression: '1+1' },
      });

      expect(r.statusCode).toBe(400);
      expect(r.json().message).toContain('total');
      expect(computedFieldDb.create).not.toHaveBeenCalled();
    });

    it('procura pela chave composta sheetApiId_name (unicidade é por API, não global)', async () => {
      await app.inject({
        method: 'POST',
        url: '/dashboard/apis/api-1/computed-fields',
        payload: { name: 'total', expression: '1+1' },
      });

      expect(argDaChamada<{ where: Record<string, unknown> }>(computedFieldDb.findUnique).where)
        .toEqual({ sheetApiId_name: { sheetApiId: 'api-1', name: 'total' } });
    });
  });
});

describe('PATCH /dashboard/apis/:id/computed-fields/:fieldId — atualização', () => {
  it('atualiza somente a expression', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/computed-fields/campo-1',
      payload: { expression: '{{a}} + {{b}}' },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().field.expression).toBe('{{a}} + {{b}}');

    const chamada = argDaChamada<{ where: { id: string }; data: Record<string, unknown> }>(computedFieldDb.update);
    expect(chamada.where).toEqual({ id: 'campo-1' });
    // Renomear via PATCH não existe: o `data` carrega só a expression.
    expect(chamada.data).toEqual({ expression: '{{a}} + {{b}}' });
  });

  it('busca o campo escopado pela API (não aceita fieldId de outra API)', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/computed-fields/campo-1',
      payload: { expression: '1+1' },
    });

    expect(argDaChamada<{ where: Record<string, unknown> }>(computedFieldDb.findFirst).where)
      .toEqual({ id: 'campo-1', sheetApiId: 'api-1' });
  });

  it('corpo sem expression → 400', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/computed-fields/campo-1',
      payload: {},
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().message).toContain('expression');
    expect(computedFieldDb.update).not.toHaveBeenCalled();
  });

  it('expression vazia → 400 (o `!body?.expression` pega string vazia)', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/computed-fields/campo-1',
      payload: { expression: '' },
    });

    expect(r.statusCode).toBe(400);
    expect(computedFieldDb.update).not.toHaveBeenCalled();
  });

  it('campo inexistente → 404', async () => {
    computedFieldDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/computed-fields/nao-existe',
      payload: { expression: '1+1' },
    });

    expect(r.statusCode).toBe(404);
    expect(r.json().message).toContain('Computed field');
    expect(computedFieldDb.update).not.toHaveBeenCalled();
  });

  it('PATCH aplica o MESMO max(500) do POST', async () => {
    // Antes o PATCH só testava `!body?.expression`, então tudo que fosse
    // truthy entrava — inclusive dez vezes o limite do POST. Quem quisesse
    // burlar o `max(500)` criava o campo com 1 caractere e dava PATCH com
    // 5000. E a expressão é avaliada para CADA linha de CADA resposta.
    const gigante = 'x'.repeat(5000);

    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/computed-fields/campo-1',
      payload: { expression: gigante },
    });

    expect(r.statusCode).toBe(400);
    expect(computedFieldDb.update).not.toHaveBeenCalled();

    // E o POST continua barrando o mesmo valor — os dois caminhos agora
    // usam a mesma regra.
    const rPost = await app.inject({
      method: 'POST',
      url: '/dashboard/apis/api-1/computed-fields',
      payload: { name: 'total', expression: gigante },
    });
    expect(rPost.statusCode).toBe(400);
  });

  it('exatamente 500 caracteres passa no PATCH — a fronteira', async () => {
    // Contraponto: a validação não podia recusar o limite legítimo.
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/computed-fields/campo-1',
      payload: { expression: 'x'.repeat(500) },
    });

    expect(r.statusCode).toBe(200);
  });

  it('PATCH recusa expression que não é string', async () => {
    // Sem Zod, um número entrava direto e o erro saía do driver do banco como
    // 500 opaco, em vez de 400 com mensagem útil.
    const r = await app.inject({
      method: 'PATCH',
      url: '/dashboard/apis/api-1/computed-fields/campo-1',
      payload: { expression: 42 },
    });

    expect(r.statusCode).toBe(400);
    expect(computedFieldDb.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /dashboard/apis/:id/computed-fields/:fieldId', () => {
  it('campo existente devolve { deleted: true }', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/dashboard/apis/api-1/computed-fields/campo-1',
    });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ deleted: true });
    expect(argDaChamada<{ where: { id: string } }>(computedFieldDb.delete).where).toEqual({ id: 'campo-1' });
  });

  it('campo inexistente → 404 e não apaga nada', async () => {
    computedFieldDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({
      method: 'DELETE',
      url: '/dashboard/apis/api-1/computed-fields/nao-existe',
    });

    expect(r.statusCode).toBe(404);
    expect(computedFieldDb.delete).not.toHaveBeenCalled();
  });

  it('confere a posse antes de procurar o campo (findFirst da API vem primeiro)', async () => {
    await app.inject({ method: 'DELETE', url: '/dashboard/apis/api-1/computed-fields/campo-1' });

    expect(argDaChamada<{ where: Record<string, unknown> }>(computedFieldDb.findFirst).where)
      .toEqual({ id: 'campo-1', sheetApiId: 'api-1' });
  });
});
