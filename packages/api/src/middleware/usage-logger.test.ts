/**
 * Testes de caracterização de `middleware/usage-logger.ts`.
 *
 * São 5 statements sem nenhum teste, mas é este hook que alimenta TODA a
 * telemetria de uso da API (`UsageLog` → gráficos do dashboard, cobrança
 * futura, detecção de abuso). Se ele parar de enfileirar, nada quebra em
 * produção — só os números somem em silêncio, que é o pior modo de falhar.
 *
 * Duas garantias merecem trava explícita:
 *   1. `path` é `request.url`, ou seja, a URL COMPLETA com querystring. Isso
 *      significa que um filtro com dado sensível (`?cpf=...`) vai parar no
 *      banco. Comportamento atual, documentado aqui de propósito.
 *   2. O hook é `onResponse`: roda depois da resposta, então o `statusCode`
 *      registrado é o final (404/500 inclusive), não o otimista.
 *
 * `usage.service` é mockado (o batching dele já tem teste próprio); o Fastify
 * é de verdade, exercitado com `app.inject()`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';

vi.mock('../services/usage.service.js', () => ({
  enqueueUsageLog: vi.fn(),
}));

const { enqueueUsageLog } = await import('../services/usage.service.js');
const enqueueMock = vi.mocked(enqueueUsageLog);

const { registerUsageLogger } = await import('./usage-logger.js');
const { montarApp, argDaChamada } = await import('../test-utils/app.js');

type SheetApiDoRequest = NonNullable<FastifyRequest['sheetApi']>;

interface EntradaDeUso {
  sheetApiId: string;
  method: string;
  path: string;
  statusCode: number;
  responseMs: number;
  ip: string | null;
}

/** SheetApi injetado no request pelo hook anterior; `null` = rota pública. */
let sheetApiAtual: { id: string } | null = null;
/** Quando definido, sobrescreve `reply.elapsedTime` para travar o arredondamento. */
let elapsedForcado: number | null = null;
/** Quantas chamadas o mock já tinha quando o handler da rota rodou. */
let chamadasDuranteOHandler = -1;

let app: FastifyInstance;

async function rotasDeTeste(instancia: FastifyInstance) {
  // Hook anterior: é o `resolveSheetApi` real que faz isso em produção.
  instancia.addHook('onRequest', async (request, reply) => {
    if (sheetApiAtual) {
      request.sheetApi = sheetApiAtual as unknown as SheetApiDoRequest;
    }
    if (elapsedForcado !== null) {
      const valor = elapsedForcado;
      Object.defineProperty(reply, 'elapsedTime', { get: () => valor, configurable: true });
    }
  });

  registerUsageLogger(instancia);

  instancia.get('/eco', async () => {
    chamadasDuranteOHandler = enqueueMock.mock.calls.length;
    return { ok: true };
  });

  instancia.post('/eco', async () => ({ criado: true }));

  instancia.get('/inexistente', async (_request, reply) => {
    return reply.code(404).send({ error: true, message: 'nao achei' });
  });

  instancia.get('/explode', async () => {
    throw new Error('boom');
  });
}

/** Lê o único argumento passado ao `enqueueUsageLog`, com tipo. */
function entradaEnfileirada(chamada = 0): EntradaDeUso {
  return argDaChamada<EntradaDeUso>(enqueueMock, chamada);
}

beforeEach(async () => {
  vi.clearAllMocks();
  sheetApiAtual = null;
  elapsedForcado = null;
  chamadasDuranteOHandler = -1;
  app = await montarApp({ rotas: rotasDeTeste });
});

describe('registerUsageLogger — registro do hook', () => {
  it('registra exatamente um hook, no evento `onResponse`', () => {
    const addHook = vi.fn();
    registerUsageLogger({ addHook } as unknown as FastifyInstance);
    expect(addHook).toHaveBeenCalledTimes(1);
    expect(argDaChamada<string>(addHook, 0, 0)).toBe('onResponse');
  });
});

describe('sem `request.sheetApi`', () => {
  it('não enfileira nada (rota que não é de planilha)', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/eco' });
    expect(resposta.statusCode).toBe(200);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('também não enfileira quando a rota erra', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/explode' });
    expect(resposta.statusCode).toBe(500);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe('com `request.sheetApi`', () => {
  beforeEach(() => {
    sheetApiAtual = { id: 'api-1' };
  });

  it('enfileira uma entrada com o shape esperado', async () => {
    await app.inject({ method: 'GET', url: '/eco', remoteAddress: '203.0.113.5' });

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const entrada = entradaEnfileirada();
    expect(entrada).toEqual({
      sheetApiId: 'api-1',
      method: 'GET',
      path: '/eco',
      statusCode: 200,
      responseMs: expect.any(Number),
      ip: '203.0.113.5',
    });
  });

  it('usa o `id` do sheetApi como `sheetApiId`', async () => {
    sheetApiAtual = { id: 'outra-api-999' };
    await app.inject({ method: 'GET', url: '/eco' });
    expect(entradaEnfileirada().sheetApiId).toBe('outra-api-999');
  });

  it('registra o método HTTP real (POST, não GET)', async () => {
    await app.inject({ method: 'POST', url: '/eco', payload: { a: 1 } });
    expect(entradaEnfileirada().method).toBe('POST');
  });

  it('enfileira uma vez por request', async () => {
    await app.inject({ method: 'GET', url: '/eco' });
    await app.inject({ method: 'GET', url: '/eco' });
    await app.inject({ method: 'POST', url: '/eco', payload: {} });
    expect(enqueueMock).toHaveBeenCalledTimes(3);
  });
});

describe('`path` é a URL completa, com querystring', () => {
  beforeEach(() => {
    sheetApiAtual = { id: 'api-1' };
  });

  it('preserva a querystring inteira (não só o caminho da rota)', async () => {
    await app.inject({ method: 'GET', url: '/eco?sheet=Agenda&limit=10' });
    expect(entradaEnfileirada().path).toBe('/eco?sheet=Agenda&limit=10');
  });

  it('grava dado sensível vindo em filtro de querystring — comportamento atual', async () => {
    // Trava consciente: o UsageLog guarda a query como veio. Um filtro por CPF
    // vira PII persistida no banco de telemetria.
    await app.inject({ method: 'GET', url: '/eco?filtro=cpf%3A12345678900' });
    const path = entradaEnfileirada().path;
    expect(path).toBe('/eco?filtro=cpf%3A12345678900');
    expect(path).toContain('12345678900');
  });
});

describe('`responseMs` = Math.round(reply.elapsedTime)', () => {
  beforeEach(() => {
    sheetApiAtual = { id: 'api-1' };
  });

  it('arredonda para cima a partir de .5', async () => {
    elapsedForcado = 12.7;
    await app.inject({ method: 'GET', url: '/eco' });
    expect(entradaEnfileirada().responseMs).toBe(13);
  });

  it('arredonda para baixo abaixo de .5', async () => {
    elapsedForcado = 12.4;
    await app.inject({ method: 'GET', url: '/eco' });
    expect(entradaEnfileirada().responseMs).toBe(12);
  });

  it('sem forçar nada, é inteiro e não negativo', async () => {
    await app.inject({ method: 'GET', url: '/eco' });
    const responseMs = entradaEnfileirada().responseMs;
    expect(Number.isInteger(responseMs)).toBe(true);
    expect(responseMs).toBeGreaterThanOrEqual(0);
  });
});

describe('hook `onResponse` — roda depois, com o statusCode final', () => {
  beforeEach(() => {
    sheetApiAtual = { id: 'api-1' };
  });

  it('não enfileira enquanto o handler ainda está executando', async () => {
    await app.inject({ method: 'GET', url: '/eco' });
    expect(chamadasDuranteOHandler).toBe(0);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('registra 404 quando a rota responde 404', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/inexistente' });
    expect(resposta.statusCode).toBe(404);
    expect(entradaEnfileirada().statusCode).toBe(404);
  });

  it('registra 500 quando o handler lança — a telemetria não some no erro', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/explode' });
    expect(resposta.statusCode).toBe(500);
    expect(entradaEnfileirada().statusCode).toBe(500);
    expect(entradaEnfileirada().path).toBe('/explode');
  });
});
