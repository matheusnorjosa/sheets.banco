/**
 * Testes de caracterização de `src/lib/prisma.ts` — hoje com 0% de cobertura.
 *
 * O arquivo faz duas coisas que ninguém revalida no dia a dia:
 *
 *   1. Decide, NA IMPORTAÇÃO, o `log` e o `errorFormat` do cliente Prisma a
 *      partir do `env`. Um erro aqui não quebra teste nenhum — só aparece em
 *      produção, ou como vazamento de query no log, ou como erro colorido/
 *      verboso indo parar no agregador de log.
 *   2. `withTransientRetry`, que é a única barreira contra um blip do pooler
 *      (Supabase) virar 503 pro consumidor. A regra de "o que é transiente"
 *      está codificada num `Set` de três códigos; qualquer outra falha — e,
 *      menos óbvio, qualquer falha SEM `code` — sobe na hora, sem repetir.
 *
 * `@prisma/client` é mockado por uma classe que só guarda as opções do
 * construtor (instanciar o cliente de verdade abriria conexão), e o `env` é
 * mockado porque o módulo real valida `process.env` e chama `process.exit(1)`.
 * O backoff NÃO é mockado: é justamente o que se quer provar, então ele é
 * medido com timers falsos.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { envFalso, opcoesDoConstrutor } = vi.hoisted(() => ({
  /** Mutável: cada cenário ajusta antes de reimportar o módulo. */
  envFalso: { LOG_LEVEL: 'info', NODE_ENV: 'development' },
  /** Uma entrada por `new PrismaClient(...)` executado. */
  opcoesDoConstrutor: [] as Array<Record<string, unknown>>,
}));

vi.mock('../config/env.js', () => ({ env: envFalso }));

vi.mock('@prisma/client', () => ({
  PrismaClient: class PrismaClientFalso {
    constructor(opcoes: Record<string, unknown> = {}) {
      opcoesDoConstrutor.push(opcoes);
    }
  },
}));

/**
 * Reimporta `prisma.ts` do zero com o env pedido. O cliente é criado no corpo
 * do módulo, então só um `vi.resetModules()` faz o construtor rodar de novo.
 */
async function importarComEnv(env: { LOG_LEVEL?: string; NODE_ENV?: string } = {}) {
  envFalso.LOG_LEVEL = env.LOG_LEVEL ?? 'info';
  envFalso.NODE_ENV = env.NODE_ENV ?? 'development';
  vi.resetModules();
  const modulo = await import('./prisma.js');
  const opcoes = opcoesDoConstrutor.at(-1);
  if (!opcoes) throw new Error('PrismaClient não foi instanciado na importação de prisma.ts');
  return { modulo, opcoes };
}

/** Erro no formato que o Prisma entrega: `Error` com `code`. */
function erroPrisma(code: string, mensagem = `falha ${code}`) {
  return Object.assign(new Error(mensagem), { code });
}

beforeEach(() => {
  vi.clearAllMocks();
  opcoesDoConstrutor.length = 0;
});

describe('configuração do PrismaClient (decidida na importação)', () => {
  it('cria exatamente um cliente por importação do módulo', async () => {
    const { modulo } = await importarComEnv();
    expect(opcoesDoConstrutor).toHaveLength(1);
    expect(modulo.prisma).toBeDefined();
  });

  it('LOG_LEVEL=debug loga query, info, warn e error', async () => {
    const { opcoes } = await importarComEnv({ LOG_LEVEL: 'debug' });
    expect(opcoes.log).toEqual(['query', 'info', 'warn', 'error']);
  });

  it('LOG_LEVEL=trace loga query, info, warn e error', async () => {
    const { opcoes } = await importarComEnv({ LOG_LEVEL: 'trace' });
    expect(opcoes.log).toEqual(['query', 'info', 'warn', 'error']);
  });

  it('LOG_LEVEL=info loga apenas warn e error (query não vaza)', async () => {
    const { opcoes } = await importarComEnv({ LOG_LEVEL: 'info' });
    expect(opcoes.log).toEqual(['warn', 'error']);
  });

  it('LOG_LEVEL=warn loga apenas warn e error', async () => {
    const { opcoes } = await importarComEnv({ LOG_LEVEL: 'warn' });
    expect(opcoes.log).toEqual(['warn', 'error']);
  });

  it('LOG_LEVEL=error/fatal caem no mesmo default de warn e error', async () => {
    expect((await importarComEnv({ LOG_LEVEL: 'error' })).opcoes.log).toEqual(['warn', 'error']);
    expect((await importarComEnv({ LOG_LEVEL: 'fatal' })).opcoes.log).toEqual(['warn', 'error']);
  });

  it('errorFormat é "minimal" em produção', async () => {
    const { opcoes } = await importarComEnv({ NODE_ENV: 'production' });
    expect(opcoes.errorFormat).toBe('minimal');
  });

  it('errorFormat é "colorless" fora de produção (development e test)', async () => {
    expect((await importarComEnv({ NODE_ENV: 'development' })).opcoes.errorFormat).toBe('colorless');
    expect((await importarComEnv({ NODE_ENV: 'test' })).opcoes.errorFormat).toBe('colorless');
  });

  it('log e errorFormat são independentes (debug em produção)', async () => {
    const { opcoes } = await importarComEnv({ LOG_LEVEL: 'debug', NODE_ENV: 'production' });
    expect(opcoes).toEqual({
      log: ['query', 'info', 'warn', 'error'],
      errorFormat: 'minimal',
    });
  });
});

describe('withTransientRetry — caminho feliz', () => {
  it('chama a função uma vez e devolve o valor quando dá certo de primeira', async () => {
    const { modulo } = await importarComEnv();
    const fn = vi.fn(async () => 'ok');

    await expect(modulo.withTransientRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('preserva o valor de retorno (objeto, não só string)', async () => {
    const { modulo } = await importarComEnv();
    const linhas = [{ id: 1 }, { id: 2 }];

    await expect(modulo.withTransientRetry(async () => linhas)).resolves.toBe(linhas);
  });
});

describe('withTransientRetry — o que é transiente', () => {
  for (const codigo of ['P1001', 'P1002', 'P1017']) {
    it(`repete quando o erro é ${codigo} e devolve o valor da 2ª tentativa`, async () => {
      const { modulo } = await importarComEnv();
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(erroPrisma(codigo))
        .mockResolvedValueOnce('recuperado');

      await expect(modulo.withTransientRetry(fn, { baseMs: 1 })).resolves.toBe('recuperado');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  }

  it('trata como transiente qualquer objeto com code transiente, mesmo sem ser Error', async () => {
    const { modulo } = await importarComEnv();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: 'P1001', message: 'pooler indisponível' })
      .mockResolvedValueOnce('recuperado');

    await expect(modulo.withTransientRetry(fn, { baseMs: 1 })).resolves.toBe('recuperado');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('lança na hora em código NÃO transiente (P2002) — uma chamada só', async () => {
    const { modulo } = await importarComEnv();
    const fn = vi.fn<() => Promise<never>>().mockRejectedValue(erroPrisma('P2002'));

    await expect(modulo.withTransientRetry(fn, { baseMs: 1 })).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('erro SEM code (Error comum) NÃO é transiente: lança na hora', async () => {
    // Regra menos óbvia do arquivo: `if (!code || !TRANSIENT_CODES.has(code)) throw err`.
    // Um timeout de socket que chegue sem `code` não ganha retry.
    const { modulo } = await importarComEnv();
    const fn = vi.fn<() => Promise<never>>().mockRejectedValue(new Error('boom'));

    await expect(modulo.withTransientRetry(fn, { baseMs: 1 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejeição com string crua também lança na hora (string não tem .code)', async () => {
    const { modulo } = await importarComEnv();
    const fn = vi.fn<() => Promise<never>>().mockRejectedValue('P1001');

    await expect(modulo.withTransientRetry(fn, { baseMs: 1 })).rejects.toBe('P1001');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withTransientRetry — limite de tentativas', () => {
  it('esgota as 3 tentativas padrão e lança o ÚLTIMO erro', async () => {
    const { modulo } = await importarComEnv();
    const fn = vi
      .fn<() => Promise<never>>()
      .mockRejectedValueOnce(erroPrisma('P1001', 'primeira'))
      .mockRejectedValueOnce(erroPrisma('P1001', 'segunda'))
      .mockRejectedValueOnce(erroPrisma('P1017', 'terceira'));

    await expect(modulo.withTransientRetry(fn, { baseMs: 1 })).rejects.toThrow('terceira');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('attempts: 1 nunca repete, mesmo com código transiente', async () => {
    const { modulo } = await importarComEnv();
    const fn = vi.fn<() => Promise<never>>().mockRejectedValue(erroPrisma('P1001'));

    await expect(modulo.withTransientRetry(fn, { attempts: 1, baseMs: 1 })).rejects.toMatchObject({
      code: 'P1001',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('attempts: 5 permite 5 chamadas antes de desistir', async () => {
    const { modulo } = await importarComEnv();
    const fn = vi.fn<() => Promise<never>>().mockRejectedValue(erroPrisma('P1002'));

    await expect(
      modulo.withTransientRetry(fn, { attempts: 5, baseMs: 1 }),
    ).rejects.toMatchObject({ code: 'P1002' });
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('attempts: 0 não chama a função e rejeita com `undefined` (comportamento atual)', async () => {
    // O laço não executa nenhuma vez, então `lastErr` continua undefined e o
    // `throw lastErr` final joga undefined. Documentado como está, não como
    // deveria ser — quem chamar com 0 recebe uma rejeição sem diagnóstico.
    const { modulo } = await importarComEnv();
    const fn = vi.fn(async () => 'ok');

    let capturado: unknown = 'não lançou';
    try {
      await modulo.withTransientRetry(fn, { attempts: 0 });
    } catch (err) {
      capturado = err;
    }

    expect(capturado).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('withTransientRetry — backoff exponencial', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('espera baseMs * 2^i entre tentativas e não espera depois da última', async () => {
    const { modulo } = await importarComEnv();
    const fn = vi.fn<() => Promise<never>>().mockRejectedValue(erroPrisma('P1001'));

    const promessa = modulo.withTransientRetry(fn, { attempts: 3, baseMs: 50 });
    promessa.catch(() => {}); // evita unhandled rejection enquanto avançamos o relógio

    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // 1ª espera = 50ms (50 * 2^0)
    await vi.advanceTimersByTimeAsync(49);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    // 2ª espera = 100ms (50 * 2^1)
    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    // Depois da última tentativa não há espera: o erro sobe imediatamente.
    expect(vi.getTimerCount()).toBe(0);
    await expect(promessa).rejects.toMatchObject({ code: 'P1001' });
  });

  it('usa baseMs 50 por padrão quando nenhuma opção é passada', async () => {
    const { modulo } = await importarComEnv();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(erroPrisma('P1017'))
      .mockResolvedValueOnce('ok');

    const promessa = modulo.withTransientRetry(fn);

    await vi.advanceTimersByTimeAsync(49);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(promessa).resolves.toBe('ok');
  });

  it('não espera nada quando a chamada dá certo de primeira', async () => {
    const { modulo } = await importarComEnv();
    const fn = vi.fn(async () => 'ok');

    await expect(modulo.withTransientRetry(fn, { baseMs: 5_000 })).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });
});
