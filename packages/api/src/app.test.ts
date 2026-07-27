/**
 * Testes de `app.ts` — a montagem da aplicação inteira.
 *
 * Este arquivo cobre o que antes era intestável: o `index.ts` chamava
 * `start()` na importação, então qualquer teste que o tocasse abriria porta e
 * conectaria no Postgres. Era o único arquivo do pacote em 0%, e justamente o
 * que decide quais rotas existem, sob quais prefixos, e com quais plugins.
 *
 * O que está travado aqui é o **contrato de montagem**, não o comportamento de
 * cada rota (esse tem teste próprio em cada arquivo):
 *
 *   1. Toda rota esperada está registrada, no prefixo certo. Esquecer um
 *      `app.register` deixa a rota inacessível em produção sem quebrar teste
 *      nenhum — os testes de rota montam a rota isoladamente e passariam.
 *   2. `/openapi.json` é público e não vaza segredo.
 *   3. O error handler está ativo (é o mesmo módulo do `test-utils`).
 *   4. `trustProxy` está ligado — a whitelist de IP depende disso.
 *
 * O `buildApp()` não abre porta, não conecta e não inicia fila. O que precisa
 * de dublê é só o que tem efeito colateral na importação: o cliente do Prisma
 * e o plugin do Redis.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('./lib/prisma.js', () => ({
  prisma: {
    sheetApi: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    apiKey: { findMany: vi.fn() },
    usageLog: { findMany: vi.fn() },
  },
  withTransientRetry: async <T>(fn: () => Promise<T>) => fn(),
}));

// O plugin real constrói um `ioredis` de verdade quando REDIS_URL existe.
// Aqui o objetivo é montar a aplicação, não testar o plugin (que tem o próprio
// arquivo), então ele vira um decorador de `null` — o mesmo caminho que roda
// em desenvolvimento sem Redis.
vi.mock('./plugins/redis.js', async () => {
  const fp = (await import('fastify-plugin')).default;
  return {
    default: fp(async (app: FastifyInstance) => {
      app.decorate('redis', null);
    }),
  };
});

vi.mock('./config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    BODY_LIMIT: 1_048_576,
    JWT_SECRET: 'segredo-de-teste-com-tamanho-mais-que-suficiente',
    HOST: '0.0.0.0',
    PORT: 3000,
    FRONTEND_URL: 'http://localhost:3001',
    ALLOWED_ORIGINS: undefined,
    REDIS_URL: 'redis://localhost:6379',
    RATE_LIMIT_MAX: 10_000,
    RATE_LIMIT_WINDOW: '1 minute',
    RATE_LIMIT_DASHBOARD_MAX: 10_000,
    RATE_LIMIT_DASHBOARD_WINDOW: '1 minute',
  },
}));

const { buildApp } = await import('./app.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  // Rota de sonda para inspecionar como o Fastify resolve o IP do cliente.
  // Registrada aqui porque não é possível adicionar rota depois do `ready()`,
  // e montar uma segunda aplicação inteira só para isso levaria mais de 5s.
  app.get('/__ip-de-sonda', async (request) => ({ ip: request.ip }));
  await app.ready();
  // Timeout generoso de propósito: montar a aplicação inteira registra ~12
  // plugins de rota, e sete deles fazem `app.register(import('@fastify/rate-limit'))`
  // — import dinâmico, resolvido em tempo de execução. O padrão de 10s do
  // vitest é apertado para isso em máquina fria. Roda uma vez por arquivo.
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('rotas registradas — nenhuma pode sumir sem quebrar teste', () => {
  /**
   * Uma rota é considerada registrada se o roteador do Fastify a resolve.
   *
   * O discriminador é o FORMATO do 404, não o status: uma rota registrada pode
   * legitimamente responder 404 (API não encontrada no banco), e nesse caso o
   * corpo vem no formato da casa (`error: true`). Rota inexistente cai no
   * handler embutido do Fastify, que responde `{"error":"Not Found"}` — string,
   * não booleano. Ver o `describe` do 404 mais abaixo.
   */
  async function existe(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string) {
    const r = await app.inject({ method, url });
    if (r.statusCode !== 404) return true;
    return r.json().error !== 'Not Found';
  }

  it.each([
    ['POST', '/auth/register'],
    ['POST', '/auth/login'],
    ['POST', '/auth/2fa/setup'],
    ['GET', '/dashboard/apis'],
    ['GET', '/dashboard/apis/api-1/webhooks'],
    ['GET', '/dashboard/apis/api-1/logs/stream'],
    ['GET', '/dashboard/apis/api-1/computed-fields'],
    ['GET', '/dashboard/apis/api-1/snapshots'],
    ['GET', '/dashboard/apis/api-1/sync'],
    ['GET', '/dashboard/apis/api-1/spreadsheets'],
    ['GET', '/api/v1/api-1'],
    ['GET', '/api/v1/api-1/schema'],
    ['GET', '/api/v1/api-1/export'],
  ] as const)('%s %s está registrada', async (metodo, url) => {
    expect(await existe(metodo, url)).toBe(true);
  });

  it('caminho que não existe é detectado como ausente pelo mesmo helper', async () => {
    // O contraponto necessário: sem ele, o helper `existe` poderia estar
    // devolvendo `true` para tudo e os testes acima não provariam nada.
    expect(await existe('GET', '/rota-que-nunca-existiu')).toBe(false);
  });
});

describe('GET /health', () => {
  it('responde 200 { status: "ok" } sem autenticação', async () => {
    // É o healthcheck do Render (`healthCheckPath: /health`). Se ele passar a
    // exigir credencial ou a depender do banco, o deploy entra em loop de
    // reinício.
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /openapi.json', () => {
  it('é público e devolve um spec OpenAPI 3', async () => {
    const r = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(r.statusCode).toBe(200);
    expect(r.json().openapi).toMatch(/^3\./);
    expect(r.json().info.title).toBe('sheets.banco API');
  });

  it('declara os três esquemas de segurança que a API aceita', async () => {
    const r = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(Object.keys(r.json().components.securitySchemes).sort()).toEqual([
      'apiKey',
      'basicAuth',
      'bearerAuth',
    ]);
  });

  it('não serve HTML — a UI do Swagger foi removida por vulnerabilidade', async () => {
    // O `@fastify/swagger-ui` arrastava `@fastify/static` com dois HIGH sem
    // correção, e o `/docs` era público. Se alguém reintroduzir, este teste
    // avisa.
    const r = await app.inject({ method: 'GET', url: '/docs' });
    expect(r.statusCode).toBe(404);
  });
});

describe('ACHADO: o 404 de rota desconhecida NÃO passa pelo error handler', () => {
  // O Fastify tem um handler de "não encontrado" separado (`setNotFoundHandler`),
  // e a aplicação não registra nenhum. Então o 404 de rota inexistente é o
  // embutido do framework e escapa do `setErrorHandler` inteiro.
  //
  // Consequência: `docs/error-handling.md` diz que TODA resposta de erro leva
  // `request_id` e o header `X-Request-Id`. Isso vale para tudo que passa pelo
  // handler — inclusive o 404 de "API não encontrada", que é um AppError — mas
  // NÃO para quem errou a URL. Quem digitou o caminho errado recebe um erro de
  // formato diferente e sem id para correlacionar com o log.
  //
  // Corrigir é um `app.setNotFoundHandler` de poucas linhas. Estes testes
  // travam o comportamento de hoje e falham de propósito quando isso for feito.

  it('responde no formato do Fastify, não no da casa', async () => {
    const r = await app.inject({ method: 'GET', url: '/nao-existe' });

    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({
      message: 'Route GET:/nao-existe not found',
      error: 'Not Found', // string, não `true` como no formato da casa
      statusCode: 404,
    });
  });

  it('não leva request_id nem o header X-Request-Id', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/nao-existe',
      headers: { 'x-request-id': 'req-do-cliente-123' },
    });

    expect(r.json().request_id).toBeUndefined();
    expect(r.headers['x-request-id']).toBeUndefined();
  });
});

describe('error handler está ativo na aplicação montada', () => {
  it('erro de validação sai no formato da casa, com request_id e X-Request-Id', async () => {
    // O `/auth/login` valida o corpo, então um POST vazio atravessa o error
    // handler de verdade — é o caminho que prova o contrato documentado.
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    const corpo = r.json();
    expect(corpo.error).toBe(true);
    expect(corpo.request_id).toBeTruthy();
    expect(r.headers['x-request-id']).toBe(corpo.request_id);
  });

  it('ecoa o X-Request-Id do cliente em vez de gerar um novo', async () => {
    // É o que permite ao suporte correlacionar o relato do cliente com o log
    // do servidor (`docs/error-handling.md`).
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {},
      headers: { 'x-request-id': 'req-do-cliente-123' },
    });

    expect(r.headers['x-request-id']).toBe('req-do-cliente-123');
    expect(r.json().request_id).toBe('req-do-cliente-123');
  });

  it('gera um request_id com prefixo req_ quando o cliente não manda', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(r.json().request_id).toMatch(/^req_/);
  });
});

describe('configuração do servidor', () => {
  it('trustProxy está ligado — a whitelist de IP depende disso', async () => {
    // Sem `trustProxy`, atrás do proxy do Render todo `request.ip` seria o IP
    // do proxy, e `middleware/ip-whitelist.ts` bloquearia (ou liberaria) todo
    // mundo junto. Com ele ligado, o `X-Forwarded-For` é respeitado.
    const r = await app.inject({
      method: 'GET',
      url: '/__ip-de-sonda',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    expect(r.json().ip).toBe('203.0.113.7');
  });

  it('sem X-Forwarded-For, usa o endereço da conexão', async () => {
    // O contraponto: prova que o teste acima mede o efeito do `trustProxy` e
    // não uma constante.
    const r = await app.inject({
      method: 'GET',
      url: '/__ip-de-sonda',
      remoteAddress: '198.51.100.4',
    });

    expect(r.json().ip).toBe('198.51.100.4');
  });

  it('helmet aplicou os cabeçalhos de segurança', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeTruthy();
  });

  it('CSP fica desligada de propósito (o frontend é separado)', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['content-security-policy']).toBeUndefined();
  });
});
