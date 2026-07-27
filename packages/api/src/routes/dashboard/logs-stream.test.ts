/**
 * Testes de caracterização de `routes/dashboard/logs-stream.ts` — SSE de logs.
 *
 * Por que este arquivo merece teste apesar de ter 23 statements: ele é o único
 * endpoint da base que escreve direto em `reply.raw` e deixa DOIS `setInterval`
 * vivos por conexão aberta (polling de 2s + heartbeat de 30s). Um vazamento de
 * intervalo aqui não dá erro nenhum — só consome CPU e mantém `reply` na
 * memória para sempre, um cliente por vez. O que o teste trava:
 *
 *   1. A verificação de dono acontece ANTES de qualquer byte ir para o socket
 *      (senão daria 200 + stream vazio em vez de 404).
 *   2. `lastChecked` só avança quando o lote traz algo — lote vazio não pode
 *      mover a janela, senão logs escritos no meio do caminho somem.
 *   3. Erro do Prisma dentro do intervalo é engolido e o intervalo sobrevive.
 *   4. O `close` do request limpa os DOIS intervalos.
 *
 * Estratégia: o caminho feliz NÃO pode ser exercitado com `app.inject()` — o
 * handler retorna `undefined` sem nunca encerrar a resposta, então o inject
 * ficaria pendurado esperando um fim que não vem. Por isso o arquivo tem duas
 * metades: as rotas que respondem de verdade (401/404) vão por `montarApp` +
 * `inject`; o SSE é exercitado invocando o handler capturado com `request`/
 * `reply` falsos e relógio falso.
 *
 * `jwtAuth` NÃO é mockado de propósito: o preHandler é parte do que se quer
 * provar (ver o teste de 401).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const sheetApiDb = { findFirst: vi.fn() };
const usageLogDb = { findMany: vi.fn() };

vi.mock('../../lib/prisma.js', () => ({
  prisma: { sheetApi: sheetApiDb, usageLog: usageLogDb },
}));

// O grafo de import não chega em `config/env.js` hoje (o rate-limiter só usa
// constantes literais), mas o mock fica como cinto de segurança: se alguém
// passar a ler env aqui, o teste não explode na importação por falta de
// DATABASE_URL.
vi.mock('../../config/env.js', () => ({
  env: { RATE_LIMIT_DASHBOARD_MAX: 1000, RATE_LIMIT_DASHBOARD_WINDOW: '1 minute' },
}));

const { montarApp, bearerDe } = await import('../../test-utils/app.js');
const { logsStreamRoutes } = await import('./logs-stream.js');
const { jwtAuth } = await import('../../middleware/jwt-auth.js');

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

interface RotaCapturada {
  url: string;
  opcoes: { preHandler?: unknown[] };
  handler: Handler;
}

/**
 * Registra o plugin num Fastify de mentira só para pegar a referência do
 * handler. É o que permite chamar a rota fora do ciclo do `inject`, que
 * travaria numa resposta que nunca termina.
 */
async function capturarRota(): Promise<RotaCapturada> {
  let capturada: RotaCapturada | undefined;
  const appFalso = {
    register: vi.fn(),
    get: vi.fn((url: string, opcoes: { preHandler?: unknown[] }, handler: Handler) => {
      capturada = { url, opcoes, handler };
    }),
  } as unknown as FastifyInstance;

  await logsStreamRoutes(appFalso);

  if (!capturada) throw new Error('logsStreamRoutes não registrou nenhuma rota GET.');
  return capturada;
}

/** `request`/`reply` mínimos: só o que o handler realmente toca. */
function criarConexaoFalsa(id = 'api-1', sub = 'user-1') {
  const write = vi.fn();
  const writeHead = vi.fn();
  const requestRaw = new EventEmitter();

  const request = {
    user: { sub },
    params: { id },
    raw: requestRaw,
  } as unknown as FastifyRequest;

  const reply = { raw: { writeHead, write } } as unknown as FastifyReply;

  return { request, reply, write, writeHead, requestRaw };
}

const API = { id: 'api-1', userId: 'user-1', name: 'Minha API' };
const T0 = new Date('2026-07-27T12:00:00.000Z');

function logEm(iso: string) {
  return {
    method: 'GET',
    path: '/api/v1/api-1',
    statusCode: 200,
    responseMs: 42,
    ip: '10.0.0.1',
    createdAt: new Date(iso),
  };
}

describe('registro da rota', () => {
  it('expõe GET /:id/logs/stream com jwtAuth como preHandler DA ROTA (não hook do plugin)', async () => {
    // Assimetria proposital em relação aos outros arquivos de dashboard, que
    // usam `app.addHook('onRequest', jwtAuth)` e portanto protegem tudo que for
    // registrado no escopo. Aqui a proteção está presa a esta rota: uma rota
    // nova adicionada neste plugin nasceria PÚBLICA se quem escrever esquecer
    // de repetir o `preHandler`.
    const { url, opcoes } = await capturarRota();

    expect(url).toBe('/:id/logs/stream');
    expect(opcoes.preHandler).toEqual([jwtAuth]);
  });
});

describe('caminhos que respondem de verdade (via inject)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    sheetApiDb.findFirst.mockReset();
    usageLogDb.findMany.mockReset();
    app = await montarApp({ rotas: logsStreamRoutes, prefixo: '/dashboard/apis' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('sem Bearer dá 401 e nem consulta o banco', async () => {
    const r = await app.inject({ method: 'GET', url: '/dashboard/apis/api-1/logs/stream' });

    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('UNAUTHORIZED');
    expect(sheetApiDb.findFirst).not.toHaveBeenCalled();
  });

  it('API de outro dono dá 404 ANTES de abrir o stream', async () => {
    // Este é o motivo de o 404 funcionar com `inject`: o `throw` acontece antes
    // do primeiro `reply.raw.writeHead`, então a resposta é uma resposta HTTP
    // normal, com JSON e tudo. Se a ordem invertesse, o cliente receberia 200 +
    // `text/event-stream` vazio e nunca saberia que a API não existe.
    sheetApiDb.findFirst.mockResolvedValue(null);

    const r = await app.inject({
      method: 'GET',
      url: '/dashboard/apis/api-de-outro/logs/stream',
      headers: { authorization: bearerDe(app, { sub: 'user-1' }) },
    });

    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('NOT_FOUND');
    expect(r.headers['content-type']).toContain('application/json');
  });

  it('o escopo do findFirst é id + userId (isolamento por dono)', async () => {
    sheetApiDb.findFirst.mockResolvedValue(null);

    await app.inject({
      method: 'GET',
      url: '/dashboard/apis/api-77/logs/stream',
      headers: { authorization: bearerDe(app, { sub: 'user-99' }) },
    });

    expect(sheetApiDb.findFirst).toHaveBeenCalledWith({
      where: { id: 'api-77', userId: 'user-99' },
    });
  });
});

describe('stream SSE (handler invocado direto, com relógio falso)', () => {
  let rota: RotaCapturada;

  beforeEach(async () => {
    vi.clearAllMocks();
    // `clearAllMocks` limpa as chamadas mas NÃO esvazia a fila de
    // `mockResolvedValueOnce`. Sem o reset explícito, um `Once` não consumido
    // (porque o teste anterior falhou antes) vaza para o teste seguinte.
    sheetApiDb.findFirst.mockReset();
    usageLogDb.findMany.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    sheetApiDb.findFirst.mockResolvedValue(API);
    usageLogDb.findMany.mockResolvedValue([]);
    rota = await capturarRota();
  });

  afterEach(() => {
    // Sem isto, qualquer intervalo que um teste tenha deixado vivo impediria o
    // vitest de encerrar o arquivo.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('abre o stream com os cabeçalhos de SSE e retorna sem encerrar a resposta', async () => {
    const { request, reply, writeHead, write, requestRaw } = criarConexaoFalsa();

    const retorno = await rota.handler(request, reply);

    expect(retorno).toBeUndefined();
    expect(writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    // Nada é escrito na abertura: o cliente só recebe bytes no primeiro lote ou
    // no primeiro heartbeat (até 30s de silêncio).
    expect(write).not.toHaveBeenCalled();

    requestRaw.emit('close');
  });

  it('cada log vira uma linha `data: {...}` com dois \\n no fim', async () => {
    const l1 = logEm('2026-07-27T12:00:01.000Z');
    const l2 = logEm('2026-07-27T12:00:01.500Z');
    usageLogDb.findMany.mockResolvedValue([l1, l2]);

    const { request, reply, write, requestRaw } = criarConexaoFalsa();
    await rota.handler(request, reply);

    await vi.advanceTimersByTimeAsync(2000);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(1, `data: ${JSON.stringify(l1)}\n\n`);
    expect(write).toHaveBeenNthCalledWith(2, `data: ${JSON.stringify(l2)}\n\n`);

    requestRaw.emit('close');
  });

  it('a consulta é escopada no sheetApiId, ordenada asc e limitada a 20', async () => {
    const { request, reply, requestRaw } = criarConexaoFalsa();
    await rota.handler(request, reply);

    await vi.advanceTimersByTimeAsync(2000);

    const args = usageLogDb.findMany.mock.calls.at(0)?.at(0) as {
      where: { sheetApiId: string; createdAt: { gt: Date } };
      orderBy: unknown;
      take: number;
      select: Record<string, boolean>;
    };
    expect(args).toBeDefined();
    expect(args.where.sheetApiId).toBe('api-1');
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
    expect(args.take).toBe(20);
    // Só colunas de telemetria — nada de userAgent, corpo ou query string.
    expect(Object.keys(args.select).sort()).toEqual(
      ['createdAt', 'ip', 'method', 'path', 'responseMs', 'statusCode'],
    );

    requestRaw.emit('close');
  });

  it('lastChecked avança para o createdAt do ÚLTIMO log do lote', async () => {
    const l1 = logEm('2026-07-27T12:00:01.000Z');
    const l2 = logEm('2026-07-27T12:00:01.500Z');
    usageLogDb.findMany.mockResolvedValueOnce([l1, l2]).mockResolvedValue([]);

    const { request, reply, requestRaw } = criarConexaoFalsa();
    await rota.handler(request, reply);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    const gts = usageLogDb.findMany.mock.calls.map(
      (c) => (c.at(0) as { where: { createdAt: { gt: Date } } }).where.createdAt.gt,
    );
    expect(gts).toHaveLength(2);
    // A primeira janela nasce do relógio (`new Date()` na abertura)...
    expect(gts[0]).toEqual(T0);
    // ...e a segunda usa o createdAt do último log, não o relógio. Se usasse o
    // relógio (12:00:02), os logs escritos entre 12:00:01,5 e 12:00:02 sumiriam.
    expect(gts[1]).toEqual(l2.createdAt);

    requestRaw.emit('close');
  });

  it('lote vazio não escreve nada e NÃO avança a janela', async () => {
    usageLogDb.findMany.mockResolvedValue([]);

    const { request, reply, write, requestRaw } = criarConexaoFalsa();
    await rota.handler(request, reply);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(write).not.toHaveBeenCalled();
    const gts = usageLogDb.findMany.mock.calls.map(
      (c) => (c.at(0) as { where: { createdAt: { gt: Date } } }).where.createdAt.gt,
    );
    expect(gts).toHaveLength(3);
    // As três consultas usam exatamente a mesma janela. É o que garante que
    // nenhum log escrito nesse intervalo seja pulado.
    expect(gts[1]).toEqual(gts[0]);
    expect(gts[2]).toEqual(gts[0]);

    requestRaw.emit('close');
  });

  it('erro do Prisma é engolido e o intervalo sobrevive para a próxima rodada', async () => {
    const l1 = logEm('2026-07-27T12:00:03.000Z');
    usageLogDb.findMany
      .mockRejectedValueOnce(new Error('conexão caiu'))
      .mockResolvedValueOnce([l1]);

    const { request, reply, write, requestRaw } = criarConexaoFalsa();
    await rota.handler(request, reply);

    // A rodada que falha não derruba nada (o `catch {}` vazio da fonte): se a
    // rejeição escapasse, este `await` rejeitaria e o teste quebraria aqui.
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(write).toHaveBeenCalledWith(`data: ${JSON.stringify(l1)}\n\n`);

    requestRaw.emit('close');
  });

  it('heartbeat escreve `: ping` a cada 30s', async () => {
    usageLogDb.findMany.mockResolvedValue([]);

    const { request, reply, write, requestRaw } = criarConexaoFalsa();
    await rota.handler(request, reply);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(': ping\n\n');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(write).toHaveBeenCalledTimes(2);

    requestRaw.emit('close');
  });

  it('`close` do request limpa os DOIS intervalos', async () => {
    usageLogDb.findMany.mockResolvedValue([]);

    const limparIntervalo = vi.spyOn(globalThis, 'clearInterval');
    const { request, reply, write, requestRaw } = criarConexaoFalsa();
    await rota.handler(request, reply);

    await vi.advanceTimersByTimeAsync(2000);
    const consultasAntes = usageLogDb.findMany.mock.calls.length;
    expect(consultasAntes).toBe(1);

    requestRaw.emit('close');
    expect(limparIntervalo).toHaveBeenCalledTimes(2);

    // Um minuto depois: nem polling, nem heartbeat. Se algum intervalo tivesse
    // escapado, seriam ~30 consultas e 2 pings — e o processo do vitest não
    // encerraria.
    usageLogDb.findMany.mockResolvedValue([logEm('2026-07-27T12:01:00.000Z')]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(usageLogDb.findMany.mock.calls.length).toBe(consultasAntes);
    expect(write).not.toHaveBeenCalled();

    limparIntervalo.mockRestore();
  });

  it('cada conexão tem sua própria janela e seus próprios intervalos', async () => {
    usageLogDb.findMany.mockResolvedValue([]);

    const a = criarConexaoFalsa('api-1', 'user-1');
    const b = criarConexaoFalsa('api-2', 'user-1');
    await rota.handler(a.request, a.reply);
    await rota.handler(b.request, b.reply);

    await vi.advanceTimersByTimeAsync(2000);

    const ids = usageLogDb.findMany.mock.calls.map(
      (c) => (c.at(0) as { where: { sheetApiId: string } }).where.sheetApiId,
    );
    expect(ids.sort()).toEqual(['api-1', 'api-2']);

    // Fechar A não pode calar B.
    a.requestRaw.emit('close');
    usageLogDb.findMany.mockClear();
    await vi.advanceTimersByTimeAsync(2000);

    const idsDepois = usageLogDb.findMany.mock.calls.map(
      (c) => (c.at(0) as { where: { sheetApiId: string } }).where.sheetApiId,
    );
    expect(idsDepois).toEqual(['api-2']);

    b.requestRaw.emit('close');
  });
});
