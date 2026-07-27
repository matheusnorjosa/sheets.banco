/**
 * Testes de caracterização do worker de sincronização agendada.
 *
 * Este worker roda fora do ciclo de request: quem o exercita em produção é o
 * BullMQ, com Redis do outro lado. Por isso ficou em 0% de cobertura — subir
 * Redis num teste unitário não é opção. A saída é mockar `bullmq` e capturar o
 * que o módulo entrega ao construtor do `Worker`: o nome da fila, as opções de
 * conexão/concorrência e, principalmente, a função processadora, que é privada
 * do módulo e só existe como 2º argumento dessa chamada.
 *
 * O que os testes travam:
 *  - o contrato com a fila (`'scheduled-sync'`, concorrência 2) — se o nome
 *    mudar aqui e não em `scheduled-sync.queue.ts`, jobs entram e nunca saem;
 *  - a tradução da URL do Redis em host/porta/senha, inclusive o fallback 6379;
 *  - o processamento (invalida o cache do spreadsheet e loga);
 *  - os handlers `completed`/`failed`, incluindo os caminhos defensivos
 *    (`if (job)` e `job.data?.`) que nunca aparecem no caminho feliz;
 *  - o `close()` idempotente, que o shutdown hook chama.
 *
 * O módulo guarda o worker num singleton de módulo (`let worker = null`), então
 * cada teste recarrega o módulo com `vi.resetModules()` para não herdar estado.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { argDaChamada } from '../test-utils/app.js';

interface OpcoesDoWorker {
  connection: { host: string; port: number; password: string | undefined };
  concurrency: number;
}

type Processador = (job: unknown) => Promise<unknown>;
type Handler = (...args: unknown[]) => void;

const { capturado, handlers, fecharMock, invalidateCacheMock, logInfo, logError } = vi.hoisted(() => ({
  capturado: {} as { nome?: string; processador?: Processador; opts?: OpcoesDoWorker; instancias: number },
  handlers: new Map<string, Handler[]>(),
  fecharMock: vi.fn(async () => {}),
  invalidateCacheMock: vi.fn(async (_spreadsheetId: string) => {}),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(nome: string, processador: Processador, opts: OpcoesDoWorker) {
      capturado.nome = nome;
      capturado.processador = processador;
      capturado.opts = opts;
      capturado.instancias = (capturado.instancias ?? 0) + 1;
    }
    on(evento: string, handler: Handler) {
      const lista = handlers.get(evento) ?? [];
      lista.push(handler);
      handlers.set(evento, lista);
      return this;
    }
    close = fecharMock;
  },
}));

vi.mock('../services/google-sheets.service.js', () => ({
  invalidateCache: invalidateCacheMock,
}));

vi.mock('../lib/logger.js', () => ({
  logger: { child: () => ({ info: logInfo, error: logError }) },
}));

const URL_REDIS = 'redis://default:minhaSenha@meu-host.upstash.io:6380';

/** Recarrega o módulo para zerar o singleton `worker` entre os testes. */
async function carregarModulo() {
  return import('./scheduled-sync.worker.js');
}

/** Lê a processadora capturada, falhando com mensagem útil se o Worker não subiu. */
function processador(): Processador {
  if (!capturado.processador) throw new Error('Worker não foi construído — processadora não capturada.');
  return capturado.processador;
}

/** Lê as opções capturadas com tipo (evita `!` sob noUncheckedIndexedAccess). */
function opcoes(): OpcoesDoWorker {
  if (!capturado.opts) throw new Error('Worker não foi construído — opções não capturadas.');
  return capturado.opts;
}

/** Dispara um evento registrado via `worker.on(...)`. */
function disparar(evento: string, ...args: unknown[]): void {
  const lista = handlers.get(evento);
  if (!lista?.length) throw new Error(`Nenhum handler registrado para "${evento}".`);
  for (const h of lista) h(...args);
}

const jobFalso = {
  id: 'job-1',
  name: 'sync',
  attemptsMade: 0,
  data: { sheetApiId: 'api-42', userId: 'user-7', spreadsheetId: 'planilha-abc' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  handlers.clear();
  delete capturado.nome;
  delete capturado.processador;
  delete capturado.opts;
  capturado.instancias = 0;
});

describe('initScheduledSyncWorker', () => {
  it('assina a fila "scheduled-sync" com concorrência 2', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();

    initScheduledSyncWorker(URL_REDIS);

    expect(capturado.nome).toBe('scheduled-sync');
    expect(opcoes().concurrency).toBe(2);
  });

  it('não configura limiter (o worker roda sem rate limit próprio)', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();

    initScheduledSyncWorker(URL_REDIS);

    expect(opcoes()).not.toHaveProperty('limiter');
  });

  it('traduz a URL do Redis em host, porta e senha', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();

    initScheduledSyncWorker(URL_REDIS);

    expect(opcoes().connection).toEqual({
      host: 'meu-host.upstash.io',
      port: 6380,
      password: 'minhaSenha',
    });
  });

  it('cai para a porta 6379 quando a URL não traz porta', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();

    initScheduledSyncWorker('redis://default:senha@sem-porta.local');

    expect(opcoes().connection.port).toBe(6379);
  });

  it('converte senha ausente em undefined (não string vazia)', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();

    initScheduledSyncWorker('redis://localhost:6379');

    expect(opcoes().connection.password).toBeUndefined();
  });

  it('mantém a senha percent-encoded como veio da URL (sem decode)', async () => {
    // Comportamento REAL, não desejado: `URL.password` devolve a forma
    // percent-encoded. Uma senha com "@" na URL chega ao Redis como "%40".
    const { initScheduledSyncWorker } = await carregarModulo();

    initScheduledSyncWorker('rediss://default:se%40nha@host.io:6380');

    expect(opcoes().connection.password).toBe('se%40nha');
  });

  it('aceita o esquema rediss:// (TLS) sem alterar host/porta', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();

    initScheduledSyncWorker('rediss://default:senha@tls-host.io:6380');

    expect(opcoes().connection.host).toBe('tls-host.io');
    expect(opcoes().connection.port).toBe(6380);
  });

  it('devolve a instância do Worker criada', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();

    const w = initScheduledSyncWorker(URL_REDIS);

    expect(w).toBeDefined();
    expect(capturado.instancias).toBe(1);
  });

  it('estoura em URL inválida (o construtor do URL rejeita antes de conectar)', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();

    expect(() => initScheduledSyncWorker('nao-e-uma-url')).toThrow();
    expect(capturado.instancias).toBe(0);
  });
});

describe('processadora do job (processSync)', () => {
  it('invalida o cache do spreadsheetId do job', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    await processador()(jobFalso);

    expect(invalidateCacheMock).toHaveBeenCalledTimes(1);
    expect(invalidateCacheMock).toHaveBeenCalledWith('planilha-abc');
  });

  it('loga sheetApiId, spreadsheetId e jobId depois de invalidar', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    await processador()(jobFalso);

    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(argDaChamada(logInfo)).toEqual({
      sheetApiId: 'api-42',
      spreadsheetId: 'planilha-abc',
      jobId: 'job-1',
    });
    expect(argDaChamada<string>(logInfo, 0, 1)).toBe('Cache invalidated');
  });

  it('resolve com undefined (o retorno do job não carrega payload)', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    await expect(processador()(jobFalso)).resolves.toBeUndefined();
  });

  it('propaga o erro de invalidateCache e não loga sucesso (BullMQ conta como falha)', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);
    invalidateCacheMock.mockRejectedValueOnce(new Error('redis fora do ar'));

    await expect(processador()(jobFalso)).rejects.toThrow('redis fora do ar');
    expect(logInfo).not.toHaveBeenCalled();
  });
});

describe('handlers de evento', () => {
  it('registra os eventos completed e failed', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();

    initScheduledSyncWorker(URL_REDIS);

    expect([...handlers.keys()]).toEqual(['completed', 'failed']);
  });

  it('completed loga jobId e sheetApiId', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    disparar('completed', jobFalso);

    expect(argDaChamada(logInfo)).toEqual({ jobId: 'job-1', sheetApiId: 'api-42' });
    expect(argDaChamada<string>(logInfo, 0, 1)).toBe('Job completed');
  });

  it('completed sem job não loga nada (guarda `if (job)`)', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    disparar('completed', undefined);

    expect(logInfo).not.toHaveBeenCalled();
  });

  it('completed com job sem data estoura — usa job.data.sheetApiId sem `?.`', async () => {
    // Assimetria REAL com o handler `failed`, que usa `job.data?.sheetApiId`.
    const { initScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    expect(() => disparar('completed', { id: 'job-9' })).toThrow(TypeError);
  });

  it('failed loga jobId, sheetApiId, tentativa e a mensagem do erro', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    disparar('failed', { ...jobFalso, attemptsMade: 2 }, new Error('timeout na API do Sheets'));

    expect(argDaChamada(logError)).toEqual({
      jobId: 'job-1',
      sheetApiId: 'api-42',
      attempt: 2,
      err: 'timeout na API do Sheets',
    });
    expect(argDaChamada<string>(logError, 0, 1)).toBe('Job failed');
  });

  it('failed com job sem data loga sheetApiId undefined (guarda `job.data?.`)', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    disparar('failed', { id: 'job-3', attemptsMade: 1 }, new Error('boom'));

    expect(logError).toHaveBeenCalledTimes(1);
    expect(argDaChamada(logError)).toEqual({
      jobId: 'job-3',
      sheetApiId: undefined,
      attempt: 1,
      err: 'boom',
    });
  });

  it('failed sem job não loga nada (guarda `if (job)`)', async () => {
    const { initScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    disparar('failed', undefined, new Error('erro sem job'));

    expect(logError).not.toHaveBeenCalled();
  });
});

describe('closeScheduledSyncWorker', () => {
  it('fecha o worker ativo', async () => {
    const { initScheduledSyncWorker, closeScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    await closeScheduledSyncWorker();

    expect(fecharMock).toHaveBeenCalledTimes(1);
  });

  it('é idempotente: a segunda chamada não fecha de novo', async () => {
    const { initScheduledSyncWorker, closeScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);

    await closeScheduledSyncWorker();
    await closeScheduledSyncWorker();

    expect(fecharMock).toHaveBeenCalledTimes(1);
  });

  it('sem init é no-op (não estoura no shutdown de um processo sem worker)', async () => {
    const { closeScheduledSyncWorker } = await carregarModulo();

    await expect(closeScheduledSyncWorker()).resolves.toBeUndefined();
    expect(fecharMock).not.toHaveBeenCalled();
  });

  it('depois de fechar, um novo init cria outra instância', async () => {
    const { initScheduledSyncWorker, closeScheduledSyncWorker } = await carregarModulo();
    initScheduledSyncWorker(URL_REDIS);
    await closeScheduledSyncWorker();

    initScheduledSyncWorker(URL_REDIS);
    await closeScheduledSyncWorker();

    expect(capturado.instancias).toBe(2);
    expect(fecharMock).toHaveBeenCalledTimes(2);
  });
});
