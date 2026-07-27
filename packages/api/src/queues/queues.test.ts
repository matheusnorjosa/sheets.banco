/**
 * Testes de caracterização das três filas BullMQ + o construtor de opções de job.
 *
 * Estes quatro arquivos (`sheets-write.queue.ts`, `webhook-delivery.queue.ts`,
 * `scheduled-sync.queue.ts` e `lib/queue-options.ts`) estavam em 0% porque só
 * são exercitados com Redis do outro lado. Mas o que eles fazem NÃO é I/O: é
 * traduzir a URL do Redis em `{ host, port, password }`, escolher o nome da
 * fila, montar a política de retry e carimbar o `jobId`. Tudo isso é decidido
 * ANTES de qualquer byte sair para a rede — e é exatamente o que quebra em
 * silêncio: se o nome da fila divergir do worker, o job entra e nunca sai; se o
 * `jobId` colidir, o BullMQ descarta a escrita sem erro.
 *
 * A estratégia é mockar `bullmq` com uma `Queue` falsa que só registra o que
 * recebeu no construtor e expõe `add`/`getRepeatableJobs`/`removeRepeatableByKey`
 * como spies. Assim os testes leem as decisões do módulo direto do argumento.
 *
 * `buildJobOptions` NÃO é mockado: o ponto dos testes de opções é justamente
 * provar o merge (override vence, default sobrevive, nada muta o objeto
 * compartilhado). Mockar seria provar o mock.
 *
 * Cada um dos três módulos guarda a fila num singleton (`let queue = null`), que
 * vazaria entre testes. Por isso o `beforeEach` faz `vi.resetModules()` +
 * `await import(...)`: sem isso o teste do "não inicializada" só passaria se
 * fosse o primeiro do arquivo.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { argDaChamada } from '../test-utils/app.js';
import type { SheetWriteJobData } from './sheets-write.queue.js';
import type { SyncJobData } from './scheduled-sync.queue.js';
import type { WebhookDeliveryJobData } from './webhook-delivery.queue.js';

interface Conexao {
  host: string;
  port: number;
  password: string | undefined;
}

interface OpcoesDaFila {
  connection: Conexao;
  defaultJobOptions: Record<string, unknown>;
}

/** Só os dois campos que `removeSyncSchedule` lê de cada repetível. */
interface RepetivelFalso {
  id: string | null;
  key: string;
}

type AddFn = (nome: string, dados: unknown, opts?: Record<string, unknown>) => Promise<{ id?: string }>;
type ListarRepetiveisFn = () => Promise<RepetivelFalso[]>;
type RemoverPorChaveFn = (chave: string) => Promise<void>;

interface FilaFalsa {
  add: Mock<AddFn>;
  getRepeatableJobs: Mock<ListarRepetiveisFn>;
  removeRepeatableByKey: Mock<RemoverPorChaveFn>;
}

interface FilaCriada {
  nome: string;
  opts: OpcoesDaFila;
  instancia: FilaFalsa;
}

const { filasCriadas } = vi.hoisted(() => ({
  filasCriadas: [] as FilaCriada[],
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add: Mock<AddFn> = vi.fn(async () => ({ id: 'job-padrao' }));
    getRepeatableJobs: Mock<ListarRepetiveisFn> = vi.fn(async () => []);
    removeRepeatableByKey: Mock<RemoverPorChaveFn> = vi.fn(async () => {});

    constructor(nome: string, opts: OpcoesDaFila) {
      filasCriadas.push({ nome, opts, instancia: this as unknown as FilaFalsa });
    }
  },
}));

/** Registro do construtor da N-ésima fila criada no teste (falha alto se não houve). */
function filaCriada(indice = 0): FilaCriada {
  const registro = filasCriadas[indice];
  if (!registro) {
    throw new Error(`Esperava ao menos ${indice + 1} fila(s) criada(s), houve ${filasCriadas.length}.`);
  }
  return registro;
}

const URL_PADRAO = 'redis://localhost:6379';

const DEFAULTS_ESPERADOS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
};

let filaDeEscrita: typeof import('./sheets-write.queue.js');
let filaDeWebhook: typeof import('./webhook-delivery.queue.js');
let filaDeSync: typeof import('./scheduled-sync.queue.js');
let opcoesDeJob: typeof import('../lib/queue-options.js');

beforeEach(async () => {
  vi.clearAllMocks();
  filasCriadas.length = 0;
  // Zera o singleton `let queue = null` dos três módulos.
  vi.resetModules();
  filaDeEscrita = await import('./sheets-write.queue.js');
  filaDeWebhook = await import('./webhook-delivery.queue.js');
  filaDeSync = await import('./scheduled-sync.queue.js');
  opcoesDeJob = await import('../lib/queue-options.js');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildJobOptions', () => {
  it('sem argumento devolve os defaults documentados', () => {
    expect(opcoesDeJob.buildJobOptions()).toEqual(DEFAULTS_ESPERADOS);
  });

  it('o override vence e o resto dos defaults permanece', () => {
    expect(opcoesDeJob.buildJobOptions({ attempts: 3, removeOnFail: { count: 42 } })).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 42 },
    });
  });

  it('não muta DEFAULT_JOB_OPTIONS: a 2ª chamada não herda os overrides da 1ª', () => {
    const primeira = opcoesDeJob.buildJobOptions({
      attempts: 99,
      backoff: { type: 'fixed', delay: 1 },
      removeOnFail: { count: 7 },
    });
    const segunda = opcoesDeJob.buildJobOptions({ removeOnComplete: { count: 11 } });

    expect(primeira.attempts).toBe(99);
    expect(segunda.attempts).toBe(5);
    expect(segunda.backoff).toEqual({ type: 'exponential', delay: 2000 });
    expect(segunda.removeOnFail).toEqual({ count: 1000 });
    expect(opcoesDeJob.DEFAULT_JOB_OPTIONS).toEqual(DEFAULTS_ESPERADOS);
  });

  it('devolve um objeto novo a cada chamada (não o próprio DEFAULT_JOB_OPTIONS)', () => {
    expect(opcoesDeJob.buildJobOptions()).not.toBe(opcoesDeJob.DEFAULT_JOB_OPTIONS);
    expect(opcoesDeJob.buildJobOptions()).not.toBe(opcoesDeJob.buildJobOptions());
  });

  it('é merge RASO: os objetos aninhados vêm por REFERÊNCIA do default', () => {
    // Caracteriza uma armadilha real: `removeOnComplete` de todas as filas que
    // não sobrescrevem é literalmente o MESMO objeto. Mutar em um lugar muda em
    // todas. Hoje ninguém muta — este teste avisa se alguém começar.
    const a = opcoesDeJob.buildJobOptions();
    const b = opcoesDeJob.buildJobOptions({ attempts: 1 });
    expect(a.removeOnComplete).toBe(opcoesDeJob.DEFAULT_JOB_OPTIONS.removeOnComplete);
    expect(a.backoff).toBe(b.backoff);
  });
});

describe('getters antes do init', () => {
  it('getSheetsWriteQueue lança "Sheets write queue not initialized"', () => {
    expect(() => filaDeEscrita.getSheetsWriteQueue()).toThrow('Sheets write queue not initialized');
  });

  it('getWebhookDeliveryQueue lança "Webhook delivery queue not initialized"', () => {
    expect(() => filaDeWebhook.getWebhookDeliveryQueue()).toThrow('Webhook delivery queue not initialized');
  });

  it('getScheduledSyncQueue lança "Scheduled sync queue not initialized"', () => {
    expect(() => filaDeSync.getScheduledSyncQueue()).toThrow('Scheduled sync queue not initialized');
  });

  it('importar os módulos não cria nenhuma fila (nada conecta no import)', () => {
    expect(filasCriadas).toHaveLength(0);
  });

  it('enqueueWrite rejeita antes do init (propaga o erro do getter)', async () => {
    await expect(
      filaDeEscrita.enqueueWrite({ type: 'append', userId: 'u1', spreadsheetId: 'planilha-abc' }),
    ).rejects.toThrow('Sheets write queue not initialized');
  });

  it('enqueueWebhookDelivery rejeita antes do init', async () => {
    await expect(
      filaDeWebhook.enqueueWebhookDelivery({
        subscriptionId: 'sub-1',
        url: 'https://exemplo.test/hook',
        secret: 's3gr3d0',
        event: 'row.created',
        payload: {},
      }),
    ).rejects.toThrow('Webhook delivery queue not initialized');
  });

  it('removeSyncSchedule rejeita antes do init', async () => {
    await expect(filaDeSync.removeSyncSchedule('api-1')).rejects.toThrow('Scheduled sync queue not initialized');
  });
});

describe('init* — nome da fila e parse da URL do Redis', () => {
  it('initSheetsWriteQueue cria a fila "sheets-write" com host/porta/senha da URL', () => {
    filaDeEscrita.initSheetsWriteQueue('redis://:s3nha@redis.interno:6380');
    expect(filaCriada().nome).toBe('sheets-write');
    expect(filaCriada().opts.connection).toEqual({
      host: 'redis.interno',
      port: 6380,
      password: 's3nha',
    });
  });

  it('initWebhookDeliveryQueue cria a fila "webhook-delivery"', () => {
    filaDeWebhook.initWebhookDeliveryQueue('redis://:s3nha@redis.interno:6380');
    expect(filaCriada().nome).toBe('webhook-delivery');
    expect(filaCriada().opts.connection).toEqual({
      host: 'redis.interno',
      port: 6380,
      password: 's3nha',
    });
  });

  it('initScheduledSyncQueue cria a fila "scheduled-sync"', () => {
    filaDeSync.initScheduledSyncQueue('redis://:s3nha@redis.interno:6380');
    expect(filaCriada().nome).toBe('scheduled-sync');
    expect(filaCriada().opts.connection).toEqual({
      host: 'redis.interno',
      port: 6380,
      password: 's3nha',
    });
  });

  it('URL sem porta cai no default 6379 (nas três filas)', () => {
    filaDeEscrita.initSheetsWriteQueue('redis://localhost');
    filaDeWebhook.initWebhookDeliveryQueue('redis://localhost');
    filaDeSync.initScheduledSyncQueue('redis://localhost');
    expect(filaCriada(0).opts.connection.port).toBe(6379);
    expect(filaCriada(1).opts.connection.port).toBe(6379);
    expect(filaCriada(2).opts.connection.port).toBe(6379);
  });

  it('URL sem senha vira password: undefined (não string vazia)', () => {
    filaDeEscrita.initSheetsWriteQueue('redis://localhost:6379');
    expect(filaCriada().opts.connection.password).toBeUndefined();
    expect('password' in filaCriada().opts.connection).toBe(true);
  });

  it('o usuário da URL é DESCARTADO — só host/porta/senha chegam ao BullMQ', () => {
    // Upstash e afins usam `default:<token>@`. O username some aqui; a conexão
    // autentica só com a senha.
    filaDeSync.initScheduledSyncQueue('redis://default:token-upstash@sa-redis.upstash.io:6379');
    expect(filaCriada().opts.connection).toEqual({
      host: 'sa-redis.upstash.io',
      port: 6379,
      password: 'token-upstash',
    });
  });

  it('o esquema rediss:// não vira opção de TLS (host/porta iguais, sem `tls`)', () => {
    filaDeWebhook.initWebhookDeliveryQueue('rediss://default:token@tls.upstash.io:6380');
    expect(filaCriada().opts.connection).toEqual({
      host: 'tls.upstash.io',
      port: 6380,
      password: 'token',
    });
  });

  it('senha percent-encoded chega SEM decodificar (`%40` não vira `@`)', () => {
    filaDeEscrita.initSheetsWriteQueue('redis://:se%40nha@localhost:6379');
    expect(filaCriada().opts.connection.password).toBe('se%40nha');
  });

  it('URL inválida explode na hora do init (new URL lança)', () => {
    expect(() => filaDeEscrita.initSheetsWriteQueue('nao-e-url')).toThrow();
    expect(filasCriadas).toHaveLength(0);
  });

  it('init devolve a mesma instância que o getter passa a devolver', () => {
    const criada = filaDeSync.initScheduledSyncQueue(URL_PADRAO);
    expect(filaDeSync.getScheduledSyncQueue()).toBe(criada);
  });

  it('chamar init duas vezes substitui o singleton pela fila mais nova', () => {
    filaDeEscrita.initSheetsWriteQueue(URL_PADRAO);
    const segunda = filaDeEscrita.initSheetsWriteQueue('redis://outro-host:6380');
    expect(filasCriadas).toHaveLength(2);
    expect(filaDeEscrita.getSheetsWriteQueue()).toBe(segunda);
  });
});

describe('defaultJobOptions por fila (os overrides documentados)', () => {
  it('sheets-write: retém mais histórico (complete 1000, fail 5000), retry padrão', () => {
    filaDeEscrita.initSheetsWriteQueue(URL_PADRAO);
    expect(filaCriada().opts.defaultJobOptions).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    });
  });

  it('webhook-delivery: backoff de 10s e fail 2000, removeOnComplete no default', () => {
    filaDeWebhook.initWebhookDeliveryQueue(URL_PADRAO);
    expect(filaCriada().opts.defaultJobOptions).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2000 },
    });
  });

  it('scheduled-sync: 3 tentativas e backoff de 5s, retenção no default', () => {
    filaDeSync.initScheduledSyncQueue(URL_PADRAO);
    expect(filaCriada().opts.defaultJobOptions).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  });
});

describe('enqueueWrite', () => {
  const AGORA = new Date('2026-07-27T12:34:56.789Z');
  const DADOS: SheetWriteJobData = {
    type: 'append',
    userId: 'user-1',
    spreadsheetId: 'planilha-abc',
    sheetName: 'Página1',
    rows: [{ nome: 'Ana' }],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AGORA);
    filaDeEscrita.initSheetsWriteQueue(URL_PADRAO);
  });

  it('usa data.type como nome do job e repassa os dados por referência', async () => {
    await filaDeEscrita.enqueueWrite(DADOS);
    const { add } = filaCriada().instancia;
    expect(add).toHaveBeenCalledTimes(1);
    expect(argDaChamada<string>(add, 0, 0)).toBe('append');
    expect(argDaChamada<SheetWriteJobData>(add, 0, 1)).toBe(DADOS);
  });

  it('monta jobId como `${type}-${spreadsheetId}-${Date.now()}`', async () => {
    await filaDeEscrita.enqueueWrite(DADOS);
    const { add } = filaCriada().instancia;
    expect(argDaChamada<{ jobId: string }>(add, 0, 2)).toEqual({
      jobId: `append-planilha-abc-${AGORA.getTime()}`,
    });
  });

  it('cada tipo de escrita gera um prefixo de jobId diferente', async () => {
    await filaDeEscrita.enqueueWrite({ ...DADOS, type: 'delete' });
    const { add } = filaCriada().instancia;
    expect(argDaChamada<{ jobId: string }>(add, 0, 2).jobId).toBe(`delete-planilha-abc-${AGORA.getTime()}`);
  });

  it('devolve o id do job', async () => {
    filaCriada().instancia.add.mockResolvedValueOnce({ id: 'job-42' });
    await expect(filaDeEscrita.enqueueWrite(DADOS)).resolves.toBe('job-42');
  });

  it("devolve 'unknown' quando o job volta sem id", async () => {
    filaCriada().instancia.add.mockResolvedValueOnce({});
    await expect(filaDeEscrita.enqueueWrite(DADOS)).resolves.toBe('unknown');
  });

  it('dois writes iguais no MESMO milissegundo geram o MESMO jobId', async () => {
    // O relógio é a única coisa que separa dois jobs. Congelado, o jobId
    // colide — e o BullMQ trata jobId repetido como duplicata (descarta em
    // silêncio). Ver `possiveisBugs`: o comentário no código diz que o jobId
    // "agrupa por spreadsheetId para evitar escritas concorrentes", mas o
    // `Date.now()` faz o oposto no caso geral.
    await filaDeEscrita.enqueueWrite(DADOS);
    await filaDeEscrita.enqueueWrite(DADOS);
    const { add } = filaCriada().instancia;
    expect(argDaChamada<{ jobId: string }>(add, 0, 2).jobId).toBe(
      argDaChamada<{ jobId: string }>(add, 1, 2).jobId,
    );
  });

  it('1ms depois o jobId muda (não há agrupamento por planilha)', async () => {
    await filaDeEscrita.enqueueWrite(DADOS);
    vi.setSystemTime(new Date(AGORA.getTime() + 1));
    await filaDeEscrita.enqueueWrite(DADOS);
    const { add } = filaCriada().instancia;
    expect(argDaChamada<{ jobId: string }>(add, 0, 2).jobId).not.toBe(
      argDaChamada<{ jobId: string }>(add, 1, 2).jobId,
    );
  });
});

describe('enqueueWebhookDelivery', () => {
  const ENTREGA: WebhookDeliveryJobData = {
    subscriptionId: 'sub-1',
    url: 'https://exemplo.test/hook',
    secret: 's3gr3d0-do-webhook',
    event: 'row.created',
    payload: { linha: 7 },
  };

  beforeEach(() => {
    filaDeWebhook.initWebhookDeliveryQueue(URL_PADRAO);
  });

  it('usa data.event como nome do job', async () => {
    await filaDeWebhook.enqueueWebhookDelivery(ENTREGA);
    const { add } = filaCriada().instancia;
    expect(add).toHaveBeenCalledTimes(1);
    expect(argDaChamada<string>(add, 0, 0)).toBe('row.created');
  });

  it('manda o payload inteiro — INCLUSIVE o secret — para dentro do job', async () => {
    await filaDeWebhook.enqueueWebhookDelivery(ENTREGA);
    const { add } = filaCriada().instancia;
    expect(argDaChamada<WebhookDeliveryJobData>(add, 0, 1)).toEqual(ENTREGA);
    expect(argDaChamada<WebhookDeliveryJobData>(add, 0, 1).secret).toBe('s3gr3d0-do-webhook');
  });

  it('não passa opções por job (sem jobId): herda só o defaultJobOptions da fila', async () => {
    await filaDeWebhook.enqueueWebhookDelivery(ENTREGA);
    const { add } = filaCriada().instancia;
    expect(argDaChamada<undefined>(add, 0, 2)).toBeUndefined();
  });

  it('resolve void (não devolve o id do job, ao contrário de enqueueWrite)', async () => {
    await expect(filaDeWebhook.enqueueWebhookDelivery(ENTREGA)).resolves.toBeUndefined();
  });

  it('nome do job acompanha o evento (event diferente, nome diferente)', async () => {
    await filaDeWebhook.enqueueWebhookDelivery({ ...ENTREGA, event: 'row.deleted' });
    const { add } = filaCriada().instancia;
    expect(argDaChamada<string>(add, 0, 0)).toBe('row.deleted');
  });
});

describe('updateSyncSchedule', () => {
  beforeEach(() => {
    filaDeSync.initScheduledSyncQueue(URL_PADRAO);
  });

  it('adiciona job "sync" com repeat.pattern e jobId sync-<id>', async () => {
    await filaDeSync.updateSyncSchedule('api-1', '0 3 * * *', 'user-1', 'planilha-abc');
    const { add } = filaCriada().instancia;
    expect(argDaChamada<string>(add, 0, 0)).toBe('sync');
    expect(argDaChamada<SyncJobData>(add, 0, 1)).toEqual({
      sheetApiId: 'api-1',
      userId: 'user-1',
      spreadsheetId: 'planilha-abc',
    });
    expect(argDaChamada<Record<string, unknown>>(add, 0, 2)).toEqual({
      repeat: { pattern: '0 3 * * *' },
      jobId: 'sync-api-1',
    });
  });

  it('REMOVE o agendamento antigo ANTES de adicionar o novo', async () => {
    const fila = filaCriada().instancia;
    fila.getRepeatableJobs.mockResolvedValueOnce([{ id: 'sync-api-1', key: 'chave-antiga' }]);

    await filaDeSync.updateSyncSchedule('api-1', '0 3 * * *', 'user-1', 'planilha-abc');

    expect(fila.removeRepeatableByKey).toHaveBeenCalledTimes(1);
    expect(fila.removeRepeatableByKey).toHaveBeenCalledWith('chave-antiga');
    expect(fila.add).toHaveBeenCalledTimes(1);
    const ordemRemocao = fila.removeRepeatableByKey.mock.invocationCallOrder[0]!;
    const ordemAdicao = fila.add.mock.invocationCallOrder[0]!;
    expect(ordemRemocao).toBeLessThan(ordemAdicao);
  });

  it('sem agendamento anterior, só adiciona (nada a remover)', async () => {
    const fila = filaCriada().instancia;
    await filaDeSync.updateSyncSchedule('api-1', '*/5 * * * *', 'user-1', 'planilha-abc');
    expect(fila.getRepeatableJobs).toHaveBeenCalledTimes(1);
    expect(fila.removeRepeatableByKey).not.toHaveBeenCalled();
    expect(fila.add).toHaveBeenCalledTimes(1);
  });

  it('não valida o cron: repassa a expressão como veio', async () => {
    await filaDeSync.updateSyncSchedule('api-1', 'cron-invalido', 'user-1', 'planilha-abc');
    const { add } = filaCriada().instancia;
    expect(argDaChamada<{ repeat: { pattern: string } }>(add, 0, 2).repeat.pattern).toBe('cron-invalido');
  });
});

describe('removeSyncSchedule', () => {
  beforeEach(() => {
    filaDeSync.initScheduledSyncQueue(URL_PADRAO);
  });

  it('remove só o repetível da API pedida, e pela `key` (não pelo id)', async () => {
    const fila = filaCriada().instancia;
    fila.getRepeatableJobs.mockResolvedValueOnce([
      { id: 'sync-api-1', key: 'chave-da-api-1' },
      { id: 'sync-api-2', key: 'chave-da-api-2' },
      { id: 'outra-coisa', key: 'chave-de-outro-job' },
    ]);

    await filaDeSync.removeSyncSchedule('api-2');

    expect(fila.removeRepeatableByKey).toHaveBeenCalledTimes(1);
    expect(fila.removeRepeatableByKey).toHaveBeenCalledWith('chave-da-api-2');
  });

  it('o casamento é por igualdade exata (id "api" não apaga "sync-api-1")', async () => {
    const fila = filaCriada().instancia;
    fila.getRepeatableJobs.mockResolvedValueOnce([{ id: 'sync-api-1', key: 'chave-da-api-1' }]);
    await filaDeSync.removeSyncSchedule('api');
    expect(fila.removeRepeatableByKey).not.toHaveBeenCalled();
  });

  it('remove TODOS os repetíveis duplicados que casam o mesmo id', async () => {
    const fila = filaCriada().instancia;
    fila.getRepeatableJobs.mockResolvedValueOnce([
      { id: 'sync-api-1', key: 'chave-velha' },
      { id: 'sync-api-1', key: 'chave-nova' },
    ]);
    await filaDeSync.removeSyncSchedule('api-1');
    expect(fila.removeRepeatableByKey).toHaveBeenCalledTimes(2);
    expect(fila.removeRepeatableByKey).toHaveBeenNthCalledWith(1, 'chave-velha');
    expect(fila.removeRepeatableByKey).toHaveBeenNthCalledWith(2, 'chave-nova');
  });

  it('ignora repetíveis com id null (agendador sem jobId customizado)', async () => {
    const fila = filaCriada().instancia;
    fila.getRepeatableJobs.mockResolvedValueOnce([{ id: null, key: 'chave-sem-id' }]);
    await filaDeSync.removeSyncSchedule('api-1');
    expect(fila.removeRepeatableByKey).not.toHaveBeenCalled();
  });

  it('é no-op quando não há nenhum repetível', async () => {
    const fila = filaCriada().instancia;
    await filaDeSync.removeSyncSchedule('api-1');
    expect(fila.getRepeatableJobs).toHaveBeenCalledTimes(1);
    expect(fila.removeRepeatableByKey).not.toHaveBeenCalled();
  });

  it('propaga erro do Redis em vez de engolir', async () => {
    const fila = filaCriada().instancia;
    fila.getRepeatableJobs.mockRejectedValueOnce(new Error('conexão recusada'));
    await expect(filaDeSync.removeSyncSchedule('api-1')).rejects.toThrow('conexão recusada');
  });
});
