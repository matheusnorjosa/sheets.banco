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
 * recebeu no construtor e expõe `add`/`upsertJobScheduler`/`removeJobScheduler`
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

/** Molde do job que o Job Scheduler do bullmq 6 carimba a cada disparo. */
interface ModeloDeJob {
  name?: string;
  data?: unknown;
  opts?: Record<string, unknown>;
}

type AddFn = (nome: string, dados: unknown, opts?: Record<string, unknown>) => Promise<{ id?: string }>;
type UpsertAgendamentoFn = (
  id: string,
  repeticao: Record<string, unknown>,
  modelo?: ModeloDeJob,
) => Promise<{ id?: string }>;
type RemoverAgendamentoFn = (id: string) => Promise<boolean>;

interface FilaFalsa {
  add: Mock<AddFn>;
  upsertJobScheduler: Mock<UpsertAgendamentoFn>;
  removeJobScheduler: Mock<RemoverAgendamentoFn>;
}

interface FilaCriada {
  nome: string;
  opts: OpcoesDaFila;
  instancia: FilaFalsa;
}

const { filasCriadas } = vi.hoisted(() => ({
  filasCriadas: [] as FilaCriada[],
}));

// As filas passaram a enfileirar por dentro de `comFilaDisponivel`, que loga a
// falha original antes de virar 503 — e o logger carrega `config/env.js`, que
// chama `process.exit(1)` quando as variáveis não estão setadas. Sem este mock
// a suíte inteira morre no import, não numa asserção.
vi.mock('../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add: Mock<AddFn> = vi.fn(async () => ({ id: 'job-padrao' }));
    upsertJobScheduler: Mock<UpsertAgendamentoFn> = vi.fn(async () => ({ id: 'job-agendado' }));
    // `true` = havia agendamento e foi removido; `false` = não havia.
    removeJobScheduler: Mock<RemoverAgendamentoFn> = vi.fn(async () => true);

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

/** Forma do erro que os `enqueue*` lançam com a fila fora (ver `queue-guard.ts`). */
interface ErroDeFila {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * Captura a rejeição com tipo útil, e falha alto se a promessa RESOLVER.
 *
 * `promessa.catch((e) => e)` sozinho devolve `void | E` no strict, e um teste
 * que só lê propriedades passaria silenciosamente se a promessa parasse de
 * rejeitar — que é justamente o que ele deveria detectar.
 */
async function erroDe(promessa: Promise<unknown>): Promise<ErroDeFila> {
  const semErro = Symbol('resolveu');
  const resultado = await promessa.then(
    () => semErro,
    (e: unknown) => e,
  );
  if (resultado === semErro) throw new Error('Esperava rejeição, mas a promessa resolveu.');
  return resultado as ErroDeFila;
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

  // Os getters acima continuam lançando o `Error` cru — é o contrato interno
  // deles. Já os `enqueue*` são chamados por rota, e sem `REDIS_URL` não existe
  // fila: isso é indisponibilidade, então sai 503 e não 500. Ver `queue-guard.ts`.
  it('enqueueWrite sem init responde 503 com a saída ?sync=true', async () => {
    const erro = await erroDe(
      filaDeEscrita.enqueueWrite({ type: 'append', userId: 'u1', spreadsheetId: 'planilha-abc' }),
    );

    expect(erro.statusCode).toBe(503);
    expect(erro.code).toBe('QUEUE_UNAVAILABLE');
    expect(erro.message).toContain('?sync=true');
  });

  it('enqueueWebhookDelivery sem init responde 503 sem prometer saída', async () => {
    const erro = await erroDe(
      filaDeWebhook.enqueueWebhookDelivery({
        subscriptionId: 'sub-1',
        deliveryId: 'entrega-1',
        url: 'https://exemplo.test/hook',
        secret: 's3gr3d0',
        event: 'row.created',
        payload: {},
      }),
    );

    expect(erro.statusCode).toBe(503);
    expect(erro.code).toBe('QUEUE_UNAVAILABLE');
    // Entrega de webhook não tem equivalente de ?sync=true.
    expect(erro.message).not.toContain('sync=true');
  });

  it('removeSyncSchedule sem init responde 503 sem prometer saída', async () => {
    const erro = await erroDe(filaDeSync.removeSyncSchedule('api-1'));

    expect(erro.statusCode).toBe(503);
    expect(erro.code).toBe('QUEUE_UNAVAILABLE');
    expect(erro.message).not.toContain('sync=true');
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

  it('URL sem senha nem usuário devolve só host e porta', () => {
    filaDeEscrita.initSheetsWriteQueue('redis://localhost:6379');
    expect(filaCriada().opts.connection).toEqual({ host: 'localhost', port: 6379 });
  });

  it('o usuário da URL é PRESERVADO — Redis 6+ com ACL autentica por usuário', () => {
    // Upstash e afins usam `default:<token>@`. Descartar o username autentica
    // como `default`, que pode não ter as permissões da fila.
    filaDeSync.initScheduledSyncQueue('redis://default:token-upstash@sa-redis.upstash.io:6379');
    expect(filaCriada().opts.connection).toEqual({
      host: 'sa-redis.upstash.io',
      port: 6379,
      username: 'default',
      password: 'token-upstash',
    });
  });

  it('o esquema rediss:// vira opção de TLS', () => {
    // Antes o esquema era descartado e nenhuma opção `tls` chegava ao BullMQ:
    // uma URL do Upstash tentaria conexão em texto claro contra um endpoint
    // que só fala TLS.
    filaDeWebhook.initWebhookDeliveryQueue('rediss://default:token@tls.upstash.io:6380');
    expect(filaCriada().opts.connection).toEqual({
      host: 'tls.upstash.io',
      port: 6380,
      username: 'default',
      password: 'token',
      tls: {},
    });
  });

  it('redis:// (sem TLS) NÃO ganha a opção tls', () => {
    // Contraponto: sem isto o teste acima não distinguiria "detecta rediss" de
    // "liga TLS sempre".
    filaDeWebhook.initWebhookDeliveryQueue('redis://localhost:6379');
    expect(filaCriada().opts.connection).not.toHaveProperty('tls');
  });

  it('senha percent-encoded é DECODIFICADA (`%40` vira `@`)', () => {
    // `@`, `:`, `/` e `#` obrigam encoding numa URL — são exatamente os
    // caracteres que um gerador de senha usa. Antes a senha chegava escapada
    // ao ioredis e a autenticação falhava com NOAUTH, sem pista no log.
    filaDeEscrita.initSheetsWriteQueue('redis://:se%40nha@localhost:6379');
    expect(filaCriada().opts.connection.password).toBe('se@nha');
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
    deliveryId: 'entrega-1',
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

/**
 * O bullmq 6 removeu os "repeatable jobs" e pôs Job Schedulers no lugar. Estes
 * testes valem pelo contrato NOVO — os antigos afirmavam propriedades da
 * implementação antiga (remoção pela `key`, duplicados com o mesmo id,
 * repetível com id `null`) que deixaram de existir e não fazia sentido manter.
 */
describe('updateSyncSchedule', () => {
  beforeEach(() => {
    filaDeSync.initScheduledSyncQueue(URL_PADRAO);
  });

  it('faz upsert do agendamento com id sync-<apiId>, o pattern e o molde do job', async () => {
    await filaDeSync.updateSyncSchedule('api-1', '0 3 * * *', 'user-1', 'planilha-abc');
    const { upsertJobScheduler } = filaCriada().instancia;

    expect(argDaChamada<string>(upsertJobScheduler, 0, 0)).toBe('sync-api-1');
    expect(argDaChamada<Record<string, unknown>>(upsertJobScheduler, 0, 1)).toEqual({ pattern: '0 3 * * *' });

    const modelo = argDaChamada<ModeloDeJob>(upsertJobScheduler, 0, 2);
    expect(modelo.name).toBe('sync');
    expect(modelo.data).toEqual<SyncJobData>({
      sheetApiId: 'api-1',
      userId: 'user-1',
      spreadsheetId: 'planilha-abc',
    });
  });

  it('NÃO enfileira job direto — agendar é upsert, não `add`', async () => {
    const fila = filaCriada().instancia;
    await filaDeSync.updateSyncSchedule('api-1', '0 3 * * *', 'user-1', 'planilha-abc');
    expect(fila.add).not.toHaveBeenCalled();
    expect(fila.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('não remove antes de agendar: o upsert é a operação inteira', async () => {
    // O código antigo fazia remove+add, o que deixava a API sem agendamento
    // nenhum entre as duas chamadas. Se alguém reintroduzir esse par, este
    // teste cai.
    const fila = filaCriada().instancia;
    await filaDeSync.updateSyncSchedule('api-1', '0 3 * * *', 'user-1', 'planilha-abc');
    expect(fila.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('reagendar a mesma API reusa o mesmo id (atualiza, não duplica)', async () => {
    const fila = filaCriada().instancia;
    await filaDeSync.updateSyncSchedule('api-1', '0 3 * * *', 'user-1', 'planilha-abc');
    await filaDeSync.updateSyncSchedule('api-1', '*/5 * * * *', 'user-1', 'planilha-abc');

    expect(fila.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(argDaChamada<string>(fila.upsertJobScheduler, 0, 0)).toBe('sync-api-1');
    expect(argDaChamada<string>(fila.upsertJobScheduler, 1, 0)).toBe('sync-api-1');
  });

  it('não valida o cron: repassa a expressão como veio', async () => {
    await filaDeSync.updateSyncSchedule('api-1', 'cron-invalido', 'user-1', 'planilha-abc');
    const { upsertJobScheduler } = filaCriada().instancia;
    expect(argDaChamada<{ pattern: string }>(upsertJobScheduler, 0, 1).pattern).toBe('cron-invalido');
  });
});

describe('removeSyncSchedule', () => {
  beforeEach(() => {
    filaDeSync.initScheduledSyncQueue(URL_PADRAO);
  });

  it('remove pelo id do agendamento da API pedida', async () => {
    const fila = filaCriada().instancia;
    await filaDeSync.removeSyncSchedule('api-2');
    expect(fila.removeJobScheduler).toHaveBeenCalledTimes(1);
    expect(fila.removeJobScheduler).toHaveBeenCalledWith('sync-api-2');
  });

  it('o id é derivado por igualdade exata ("api" não vira "sync-api-1")', async () => {
    const fila = filaCriada().instancia;
    await filaDeSync.removeSyncSchedule('api');
    expect(fila.removeJobScheduler).toHaveBeenCalledWith('sync-api');
  });

  it('é no-op quando não havia agendamento (removeJobScheduler devolve false)', async () => {
    const fila = filaCriada().instancia;
    fila.removeJobScheduler.mockResolvedValueOnce(false);
    await expect(filaDeSync.removeSyncSchedule('api-1')).resolves.toBeUndefined();
  });

  it('propaga erro do Redis em vez de engolir', async () => {
    const fila = filaCriada().instancia;
    fila.removeJobScheduler.mockRejectedValueOnce(new Error('conexão recusada'));
    await expect(filaDeSync.removeSyncSchedule('api-1')).rejects.toThrow('conexão recusada');
  });
});
