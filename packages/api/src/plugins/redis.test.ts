/**
 * Testes de caracterização de `plugins/redis.ts` — 20 statements que estavam
 * com 0% de cobertura e que decidem, no boot, se a API roda com cache ou sem.
 *
 * Três comportamentos justificam o arquivo:
 *
 *   1. O "pular Redis" (decorar `app.redis = null`) é o que impede a API de
 *      queimar segundos por request em ECONNREFUSED quando não há Redis. A
 *      condição que decide isso mistura `process.env.REDIS_URL` (presença crua)
 *      com `env.REDIS_URL` (valor já validado pelo zod). Os testes abaixo põem
 *      os dois divergindo de propósito, para travar qual manda em cada braço.
 *   2. O `retryStrategy` decide quando desistir de reconectar. Errar ali é
 *      reconexão infinita ou desistência cedo demais.
 *   3. A supressão de erro repetido só é aceitável porque o handler de
 *      `connect` reseta o flag. Sem esse reset, um Redis instável logaria uma
 *      única vez e ficaria mudo para sempre.
 *
 * `ioredis` é mockado (não queremos socket de verdade), mas tudo que está sob
 * prova — condição de skip, opções passadas, `retryStrategy`, supressão e o
 * hook `onClose` — roda de verdade, dentro de um Fastify de verdade.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { argDaChamada } from '../test-utils/app.js';

/** Mesmo literal do módulo sob teste (lá é `const DEFAULT_LOCAL`). */
const LOCAL_PADRAO = 'redis://localhost:6379';
const URL_REAL = 'redis://:senha@redis-prod.upstash.io:6379';

interface OpcoesRedis {
  maxRetriesPerRequest: number;
  enableOfflineQueue: boolean;
  lazyConnect: boolean;
  connectTimeout: number;
  retryStrategy: (times: number) => number | null;
}

interface RedisFalso {
  on: Mock;
  quit: Mock;
}

// `vi.hoisted` porque as fábricas de `vi.mock` sobem para o topo do arquivo e
// precisam enxergar estas referências.
const { construtorRedis, estado, envFalso } = vi.hoisted(() => ({
  construtorRedis: vi.fn(),
  estado: { ultimaInstancia: null as unknown },
  envFalso: { REDIS_URL: 'redis://localhost:6379' },
}));

// O env.js real valida o ambiente na importação e chama process.exit(1).
vi.mock('../config/env.js', () => ({ env: envFalso }));

vi.mock('ioredis', () => {
  class Redis {
    on = vi.fn();
    quit = vi.fn(async () => 'OK');

    constructor(url: string, opcoes: unknown) {
      construtorRedis(url, opcoes);
      estado.ultimaInstancia = this;
    }
  }
  return { Redis };
});

const { default: pluginRedis } = await import('./redis.js');

const appsAbertos: FastifyInstance[] = [];

interface AppMontado {
  app: FastifyInstance;
  warn: Mock;
  error: Mock;
  info: Mock;
}

/**
 * Sobe um Fastify de verdade com o plugin registrado. Os espiões de log entram
 * ANTES do `register` porque o braço de skip loga durante o próprio boot.
 */
async function montarComPlugin(): Promise<AppMontado> {
  const app = Fastify({ logger: false });
  const warn = vi.spyOn(app.log, 'warn') as unknown as Mock;
  const error = vi.spyOn(app.log, 'error') as unknown as Mock;
  const info = vi.spyOn(app.log, 'info') as unknown as Mock;
  appsAbertos.push(app);
  await app.register(pluginRedis);
  return { app, warn, error, info };
}

/** Última instância falsa de Redis construída pelo plugin. */
function instanciaRedis(): RedisFalso {
  if (!estado.ultimaInstancia) {
    throw new Error('Nenhuma instância de Redis foi construída.');
  }
  return estado.ultimaInstancia as RedisFalso;
}

/** Lê o listener registrado via `redis.on(evento, handler)`. */
function handlerDe(evento: string): (...args: unknown[]) => void {
  const instancia = instanciaRedis();
  const chamada = instancia.on.mock.calls.findIndex((args) => args[0] === evento);
  if (chamada === -1) {
    throw new Error(`Handler de '${evento}' não foi registrado.`);
  }
  return argDaChamada<(...args: unknown[]) => void>(instancia.on, chamada, 1);
}

/** Opções passadas ao construtor do Redis na primeira (e única) construção. */
function opcoesDoConstrutor(): OpcoesRedis {
  return argDaChamada<OpcoesRedis>(construtorRedis, 0, 1);
}

beforeEach(() => {
  vi.clearAllMocks();
  estado.ultimaInstancia = null;
  envFalso.REDIS_URL = LOCAL_PADRAO;
});

afterEach(async () => {
  for (const app of appsAbertos) {
    await app.close().catch(() => {});
  }
  appsAbertos.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sem REDIS_URL no ambiente', () => {
  it('decora app.redis = null, não constrói Redis e loga warn', async () => {
    vi.stubEnv('REDIS_URL', undefined);

    const { app, warn } = await montarComPlugin();

    expect(app.redis).toBeNull();
    expect(construtorRedis).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('REDIS_URL not configured — running without cache');
  });

  it('pula mesmo quando env.REDIS_URL traz uma URL real (a presença crua manda no 1º braço)', async () => {
    // Divergência proposital: o zod entregou uma URL de produção, mas
    // process.env.REDIS_URL não existe. O `!process.env.REDIS_URL` vence.
    vi.stubEnv('REDIS_URL', undefined);
    envFalso.REDIS_URL = URL_REAL;

    const { app, warn } = await montarComPlugin();

    expect(app.redis).toBeNull();
    expect(construtorRedis).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('trata REDIS_URL vazia como ausente (a checagem é de truthiness, não de "in process.env")', async () => {
    vi.stubEnv('REDIS_URL', '');
    envFalso.REDIS_URL = URL_REAL;

    const { app } = await montarComPlugin();

    expect(app.redis).toBeNull();
    expect(construtorRedis).not.toHaveBeenCalled();
  });
});

describe('com REDIS_URL igual ao default local', () => {
  it('pula o Redis quando os dois valores são o default local', async () => {
    vi.stubEnv('REDIS_URL', LOCAL_PADRAO);
    envFalso.REDIS_URL = LOCAL_PADRAO;

    const { app, warn } = await montarComPlugin();

    expect(app.redis).toBeNull();
    expect(construtorRedis).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('REDIS_URL not configured — running without cache');
  });

  it('pula mesmo com process.env.REDIS_URL apontando para produção (o valor VALIDADO manda no 2º braço)', async () => {
    // Divergência proposital: alguém setou a variável crua, mas o valor que o
    // zod entregou continua sendo o default local. `env.REDIS_URL` vence.
    vi.stubEnv('REDIS_URL', URL_REAL);
    envFalso.REDIS_URL = LOCAL_PADRAO;

    const { app } = await montarComPlugin();

    expect(app.redis).toBeNull();
    expect(construtorRedis).not.toHaveBeenCalled();
  });

  it('CONECTA quando a variável crua é o default local mas env.REDIS_URL é outra — e conecta em env.REDIS_URL', async () => {
    // Divergência inversa: process.env.REDIS_URL só é lido para saber se existe;
    // a URL efetivamente usada é sempre `env.REDIS_URL`.
    vi.stubEnv('REDIS_URL', LOCAL_PADRAO);
    envFalso.REDIS_URL = URL_REAL;

    const { app } = await montarComPlugin();

    expect(construtorRedis).toHaveBeenCalledTimes(1);
    expect(argDaChamada<string>(construtorRedis, 0, 0)).toBe(URL_REAL);
    expect(app.redis as unknown).toBe(instanciaRedis());
  });
});

describe('com REDIS_URL real', () => {
  beforeEach(() => {
    vi.stubEnv('REDIS_URL', URL_REAL);
    envFalso.REDIS_URL = URL_REAL;
  });

  it('constrói o Redis com a URL validada e as opções exatas', async () => {
    await montarComPlugin();

    expect(construtorRedis).toHaveBeenCalledTimes(1);
    expect(argDaChamada<string>(construtorRedis, 0, 0)).toBe(URL_REAL);

    const opcoes = opcoesDoConstrutor();
    expect(opcoes.maxRetriesPerRequest).toBe(1);
    expect(opcoes.enableOfflineQueue).toBe(false);
    expect(opcoes.lazyConnect).toBe(false);
    expect(opcoes.connectTimeout).toBe(5000);
    expect(typeof opcoes.retryStrategy).toBe('function');
  });

  it('decora app.redis com a instância e não loga o warn de "sem cache"', async () => {
    const { app, warn } = await montarComPlugin();

    expect(app.redis).not.toBeNull();
    expect(app.redis as unknown).toBe(instanciaRedis());
    expect(warn).not.toHaveBeenCalled();
  });

  it('registra exatamente os listeners de "error" e "connect"', async () => {
    await montarComPlugin();

    const eventos = instanciaRedis().on.mock.calls.map((args) => args[0]);
    expect(eventos).toEqual(['error', 'connect']);
  });
});

describe('retryStrategy', () => {
  beforeEach(async () => {
    vi.stubEnv('REDIS_URL', URL_REAL);
    envFalso.REDIS_URL = URL_REAL;
    await montarComPlugin();
  });

  it('1ª tentativa espera 200ms', () => {
    expect(opcoesDoConstrutor().retryStrategy(1)).toBe(200);
  });

  it('cresce linearmente (times * 200)', () => {
    const { retryStrategy } = opcoesDoConstrutor();
    expect(retryStrategy(2)).toBe(400);
    expect(retryStrategy(5)).toBe(1000);
  });

  it('na fronteira, times=10 ainda devolve número (2000ms)', () => {
    expect(opcoesDoConstrutor().retryStrategy(10)).toBe(2000);
  });

  it('NUNCA devolve null — desistir de reconectar deixaria o cache morto até reiniciar', () => {
    // Este é o teste que fecha o defeito. Antes havia
    // `if (times > 10) return null`, e `null` no ioredis significa parar de
    // reconectar PARA SEMPRE. Como o backoff somava 200+400+…+2000 = 11s,
    // qualquer queda do Upstash maior que isso desligava o cache até alguém
    // reiniciar o processo — em silêncio, porque o `cache.service` engole erro
    // de propósito e o cliente usa `enableOfflineQueue: false`.
    const estrategia = opcoesDoConstrutor().retryStrategy;
    for (const tentativa of [1, 10, 11, 25, 100, 10_000]) {
      expect(estrategia(tentativa)).not.toBeNull();
      expect(typeof estrategia(tentativa)).toBe('number');
    }
  });

  it('o backoff cresce e para no teto de 30s', () => {
    const estrategia = opcoesDoConstrutor().retryStrategy;
    expect(estrategia(11)).toBe(2200);
    expect(estrategia(150)).toBe(30_000); // 150 * 200 = 30000, exatamente no teto
    expect(estrategia(10_000)).toBe(30_000); // e não passa dele
  });

  it('times=0 devolve 0 (sem piso mínimo de espera)', () => {
    expect(opcoesDoConstrutor().retryStrategy(0)).toBe(0);
  });
});

describe('supressão de erro repetido', () => {
  beforeEach(() => {
    vi.stubEnv('REDIS_URL', URL_REAL);
    envFalso.REDIS_URL = URL_REAL;
  });

  it('loga o 1º erro com o objeto err e a mensagem de supressão', async () => {
    const { error } = await montarComPlugin();
    const erro = new Error('ECONNREFUSED');

    handlerDe('error')(erro);

    expect(error).toHaveBeenCalledTimes(1);
    expect(argDaChamada<{ err: Error }>(error, 0, 0)).toEqual({ err: erro });
    expect(argDaChamada<string>(error, 0, 1)).toBe(
      'Redis connection error (further errors suppressed)',
    );
  });

  it('NÃO loga o 2º erro seguido', async () => {
    const { error } = await montarComPlugin();
    const onError = handlerDe('error');

    onError(new Error('primeiro'));
    onError(new Error('segundo'));
    onError(new Error('terceiro'));

    expect(error).toHaveBeenCalledTimes(1);
  });

  it('"connect" loga info e RESETA a supressão — o erro seguinte volta a logar', async () => {
    const { error, info } = await montarComPlugin();
    const onError = handlerDe('error');

    onError(new Error('antes do connect'));
    expect(error).toHaveBeenCalledTimes(1);

    handlerDe('connect')();
    expect(info).toHaveBeenCalledWith('Redis connected');

    onError(new Error('depois do connect'));
    expect(error).toHaveBeenCalledTimes(2);

    // ...e volta a suprimir a partir do segundo do novo ciclo.
    onError(new Error('mais um'));
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe('onClose', () => {
  it('chama redis.quit() ao fechar o app', async () => {
    vi.stubEnv('REDIS_URL', URL_REAL);
    envFalso.REDIS_URL = URL_REAL;
    const { app } = await montarComPlugin();
    const instancia = instanciaRedis();

    expect(instancia.quit).not.toHaveBeenCalled();
    await app.close();

    expect(instancia.quit).toHaveBeenCalledTimes(1);
  });

  it('o close resolve mesmo se o quit rejeitar (o .catch engole)', async () => {
    vi.stubEnv('REDIS_URL', URL_REAL);
    envFalso.REDIS_URL = URL_REAL;
    const { app } = await montarComPlugin();
    const instancia = instanciaRedis();
    instancia.quit.mockRejectedValue(new Error('conexão já morta'));

    await expect(app.close()).resolves.toBeUndefined();
    expect(instancia.quit).toHaveBeenCalledTimes(1);
  });

  it('quando o Redis foi pulado, nenhum hook onClose é registrado e o close passa', async () => {
    vi.stubEnv('REDIS_URL', undefined);
    const { app } = await montarComPlugin();

    await expect(app.close()).resolves.toBeUndefined();
    expect(construtorRedis).not.toHaveBeenCalled();
  });
});
