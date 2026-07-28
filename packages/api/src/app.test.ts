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
import pino from 'pino';

/** Hoisted para os testes conseguirem controlar a resolução da SheetApi. */
const sheetApiDb = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('./lib/prisma.js', () => ({
  prisma: {
    sheetApi: sheetApiDb,
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
   * O discriminador é o `code`, não o status: uma rota registrada pode
   * legitimamente responder 404 (API não encontrada no banco), e nesse caso o
   * `code` é `NOT_FOUND`. Só o handler de rota desconhecida usa
   * `ROUTE_NOT_FOUND`. Ver o `describe` do 404 mais abaixo.
   */
  async function existe(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string) {
    const r = await app.inject({ method, url });
    if (r.statusCode !== 404) return true;
    return r.json().code !== 'ROUTE_NOT_FOUND';
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

describe('404 de rota desconhecida sai no formato da casa', () => {
  // O Fastify não manda o 404 de rota desconhecida para o `setErrorHandler` —
  // tem um caminho próprio, o `setNotFoundHandler`. Antes a aplicação não
  // registrava nenhum, e o embutido do framework respondia
  // `{"error":"Not Found"}` — sem `error: true`, sem `code`, sem `request_id`
  // e sem o header `X-Request-Id`, contrariando o que
  // `docs/error-handling.md` promete para toda resposta de erro. Atingia só
  // quem digitou a URL errada; o 404 de "API não encontrada" é um AppError e
  // sempre saiu certo.

  it('responde com error:true, code e statusCode', async () => {
    const r = await app.inject({ method: 'GET', url: '/nao-existe' });

    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({
      error: true,
      message: 'Route GET:/nao-existe not found',
      code: 'ROUTE_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('leva request_id e o header X-Request-Id, ecoando o do cliente', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/nao-existe',
      headers: { 'x-request-id': 'req-do-cliente-123' },
    });

    expect(r.json().request_id).toBe('req-do-cliente-123');
    expect(r.headers['x-request-id']).toBe('req-do-cliente-123');
  });

  it('gera request_id próprio quando o cliente não manda', async () => {
    const r = await app.inject({ method: 'GET', url: '/nao-existe' });
    expect(r.json().request_id).toMatch(/^req_/);
    expect(r.headers['x-request-id']).toBe(r.json().request_id);
  });

  it('o formato bate com o dos demais erros da API', async () => {
    // O ponto do PR: um cliente que trate erro genericamente não precisa de
    // caso especial para URL errada.
    const naoEncontrado = await app.inject({ method: 'GET', url: '/nao-existe' });
    const validacao = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });

    expect(Object.keys(naoEncontrado.json()).sort())
      .toEqual(Object.keys(validacao.json()).sort());
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

describe('TODA resposta de erro carrega request_id', () => {
  // O `setErrorHandler` só vê o que é LANÇADO. Mas 31 pontos em 10 arquivos
  // respondem com `reply.status(n).send({ error: true, ... })` direto, e essas
  // saíam sem `request_id` e sem `X-Request-Id` — contrariando a primeira
  // linha de `docs/error-handling.md`. Um hook de `preSerialization` completa
  // o envelope nos dois caminhos.

  it('erro LANÇADO (validação) traz request_id', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(r.json().request_id).toBeTruthy();
    expect(r.headers['x-request-id']).toBe(r.json().request_id);
  });

  it('erro ENVIADO direto pelo reply também traz — este é o que faltava', async () => {
    // `/api/v1/:apiId` sem credencial cai no `apiAuth`, que responde pelo
    // `reply` sem lançar. Antes, esta resposta não tinha correlação de log.
    const api = {
      id: 'api-1', slug: 'x', userId: 'u1', spreadsheetId: 's1',
      authEnabled: true, bearerToken: 'tok', bearerTokenHash: null,
      allowRead: true, corsOrigins: null, ipWhitelist: null, rateLimitRpm: 60,
    };
    // O resolver tenta `findUnique` pelo id e `findFirst` pelo slug.
    sheetApiDb.findUnique.mockResolvedValue(api);
    sheetApiDb.findFirst.mockResolvedValue(api);

    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1' });

    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('API_UNAUTHORIZED');
    expect(r.json().request_id).toBeTruthy();
    expect(r.headers['x-request-id']).toBe(r.json().request_id);
  });

  it('resposta de SUCESSO não ganha request_id — o hook só mexe em erro', async () => {
    // Contraponto: sem ele o hook poderia estar poluindo toda resposta.
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
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

describe('log de requisição não grava segredo da query', () => {
  /**
   * Captura as linhas que o logger da aplicação REAL emitiu durante a injeção.
   *
   * Testar `sanitizarUrl` isolado prova que a função funciona; só isto prova
   * que ela está LIGADA no `buildApp`. Esquecer o `serializers:` nas opções do
   * Fastify passaria por todos os testes de `lib/logger.ts`.
   *
   * O `LOG_LEVEL` do dublê de env é `silent` — sem subir o nível aqui, o pino
   * não emitiria nada e o teste passaria vazio, que é o pior resultado
   * possível num teste de vazamento.
   */
  async function linhasDeLogAoPedir(url: string) {
    const linhas: Record<string, unknown>[] = [];
    const alvo = app.log as unknown as Record<symbol, unknown>;
    const streamOriginal = alvo[pino.symbols.streamSym];
    const nivelOriginal = app.log.level;

    alvo[pino.symbols.streamSym] = {
      write(linha: string) {
        linhas.push(JSON.parse(linha) as Record<string, unknown>);
      },
    };
    app.log.level = 'info';

    try {
      await app.inject({ method: 'GET', url });
    } finally {
      app.log.level = nivelOriginal;
      alvo[pino.symbols.streamSym] = streamOriginal;
    }

    return linhas;
  }

  it('não escreve o token de sessão que vem em ?token=', async () => {
    const linhas = await linhasDeLogAoPedir('/auth/google?token=jwt-que-nao-pode-vazar');

    expect(linhas.length).toBeGreaterThan(0); // senão não testou nada
    expect(JSON.stringify(linhas)).not.toContain('jwt-que-nao-pode-vazar');
  });

  it('registra a rota com o valor redigido, não a linha inteira suprimida', async () => {
    // Contraponto: sem isto, um serializador que devolvesse `{}` também
    // passaria no teste acima — e teríamos trocado um vazamento por um log
    // cego.
    const linhas = await linhasDeLogAoPedir('/auth/google?token=jwt-que-nao-pode-vazar');
    const comRequisicao = linhas.find((l) => l.req);
    const req = comRequisicao?.req as { url?: string; method?: string } | undefined;

    expect(req?.method).toBe('GET');
    expect(req?.url).toContain('/auth/google');
    expect(req?.url).toContain('REDACTED');
  });

  it('preserva parâmetro não sensível na mesma linha', async () => {
    const linhas = await linhasDeLogAoPedir('/api/v1/qualquer?sheet=DAT&token=segredo');
    const req = linhas.find((l) => l.req)?.req as { url?: string } | undefined;

    expect(req?.url).toContain('sheet=DAT');
    expect(JSON.stringify(linhas)).not.toContain('segredo');
  });
});
