/**
 * Testes de caracterização de `workers/webhook-delivery.worker.ts`.
 *
 * Este é o único ponto do sistema que **assina** o que sai para servidor de
 * terceiro. Se a fórmula do HMAC, o corpo assinado ou o formato do header
 * mudarem sem querer, todo consumidor passa a rejeitar em silêncio — ou, pior,
 * aceita coisa que não deveria. Nada aqui tinha teste (0% de cobertura).
 *
 * O que estes testes travam:
 *   1. `X-Signature-256 = sha256=HMAC(segredo, "<ts>.<body>")`, recalculado no
 *      teste com `crypto` de verdade (o `secret-cipher` e o `crypto` NÃO são
 *      mockados — mockar a coisa sob prova faz o teste passar com ela quebrada).
 *   2. O segredo trafega CIFRADO no job (envelope `gcm$…`) e só é decifrado na
 *      hora de assinar; o envelope não vaza em header nem no corpo.
 *   3. Dual-read: segredo legado em texto claro continua funcionando.
 *   4. Máquina de estados da entrega (success / failed / pending) e o
 *      `attempts = attemptsMade + 1`.
 *   5. O timer de 10s do AbortController é limpo nos dois caminhos.
 *
 * `bullmq` é mockado por classe para capturar o `processJob` — ele é privado do
 * módulo, mas é passado como 2º argumento ao construtor do `Worker`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { argDaChamada } from '../test-utils/app.js';

// ---------------------------------------------------------------------------
// Mocks (hoisted — `vi.mock` sobe acima dos imports)
// ---------------------------------------------------------------------------

interface OptsWorker {
  connection: { host: string; port: number; password?: string };
  concurrency: number;
}

type Handler = (...args: unknown[]) => void;

const capturado = vi.hoisted(() => ({
  nome: undefined as string | undefined,
  processador: undefined as ((job: unknown) => Promise<void>) | undefined,
  opts: undefined as Record<string, unknown> | undefined,
  handlers: [] as Array<[string, (...args: unknown[]) => void]>,
  fechados: 0,
  /** Última instância construída — usada para provar o valor de RETORNO do init. */
  instancia: undefined as unknown,
}));

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(
      nome: string,
      processador: (job: unknown) => Promise<void>,
      opts: Record<string, unknown>,
    ) {
      capturado.nome = nome;
      capturado.processador = processador;
      capturado.opts = opts;
      capturado.instancia = this;
    }
    on(evento: string, handler: (...args: unknown[]) => void) {
      capturado.handlers.push([evento, handler]);
      return this;
    }
    async close() {
      capturado.fechados += 1;
    }
  },
}));

const updateManyMock = vi.hoisted(() =>
  vi.fn(async (_args: unknown) => ({ count: 1 })),
);

vi.mock('../lib/prisma.js', () => ({
  prisma: { webhookDelivery: { updateMany: updateManyMock } },
}));

const logErro = vi.hoisted(() => vi.fn());

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: () => ({ error: logErro, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));

// Defensivo: `config/env.js` valida env na importação e chama process.exit(1).
vi.mock('../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const fetchMock = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Cifra REAL — o ponto 2 dos testes é justamente provar que o envelope é aberto
// ---------------------------------------------------------------------------
const CHAVE_ORIGINAL = process.env.SECRETS_ENC_KEY;

beforeAll(() => {
  // Chave efêmera por rodada. NUNCA um segredo real.
  process.env.SECRETS_ENC_KEY = crypto.randomBytes(32).toString('hex');
});

afterAll(() => {
  if (CHAVE_ORIGINAL === undefined) delete process.env.SECRETS_ENC_KEY;
  else process.env.SECRETS_ENC_KEY = CHAVE_ORIGINAL;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const URL_REDIS = 'redis://default:senha-do-redis@redis.example.com:6380';
const RELOGIO = new Date('2026-07-27T12:34:56.789Z');
const TS_ESPERADO = Math.floor(RELOGIO.getTime() / 1000);

interface DadosJob {
  subscriptionId: string;
  deliveryId: string;
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
}

interface JobFalso {
  id: string | undefined;
  name: string;
  data: DadosJob;
  attemptsMade: number;
}

type OverJob = Partial<Omit<JobFalso, 'data'>> & { data?: Partial<DadosJob> };

function jobFalso(over: OverJob = {}): JobFalso {
  return {
    id: 'entrega-1',
    name: 'row.created',
    attemptsMade: 0,
    ...over,
    data: {
      subscriptionId: 'sub-1',
      // Cuid, como o Prisma gera — deliberadamente diferente do `id` do job
      // acima, que é o contador do BullMQ. Confundir os dois era o defeito.
      deliveryId: 'clx0entrega0padrao',
      url: 'https://destino.example.com/hook',
      secret: 'segredo-legado-em-claro',
      event: 'row.created',
      payload: { linha: 7, nome: 'Fulano' },
      ...over.data,
    },
  };
}

interface HeadersEnviados {
  'Content-Type': string;
  'X-Webhook-Event': string;
  'X-Webhook-Delivery-Id': string;
  'X-Webhook-Timestamp': string;
  'X-Signature-256': string;
}

interface InitFetch {
  method: string;
  headers: HeadersEnviados;
  body: string;
  signal: AbortSignal;
}

interface ArgsUpdate {
  where: { subscriptionId: string; id?: string };
  data: { status: string; attempts: number; responseCode?: number };
}

function initDoFetch(chamada = 0): InitFetch {
  return argDaChamada<InitFetch>(fetchMock, chamada, 1);
}

function urlDoFetch(chamada = 0): string {
  return argDaChamada<string>(fetchMock, chamada, 0);
}

function argsUpdate(chamada = 0): ArgsUpdate {
  return argDaChamada<ArgsUpdate>(updateManyMock, chamada, 0);
}

/** HMAC-SHA256 hex, mesma fórmula do worker — recalculada, nunca mockada. */
function assinar(segredo: string, ts: string, body: string): string {
  return crypto.createHmac('sha256', segredo).update(`${ts}.${body}`).digest('hex');
}

let modulo: typeof import('./webhook-delivery.worker.js');

/** O `processJob` capturado do construtor do Worker. */
function processador(): (job: unknown) => Promise<void> {
  const p = capturado.processador;
  if (!p) throw new Error('bullmq.Worker não recebeu o processador');
  return p;
}

beforeEach(async () => {
  vi.clearAllMocks();
  // O módulo guarda `let worker` em variável de módulo — sem reset o singleton
  // vaza entre testes e o `close()` de um teste some no seguinte.
  vi.resetModules();

  capturado.nome = undefined;
  capturado.processador = undefined;
  capturado.opts = undefined;
  capturado.handlers.length = 0;
  capturado.fechados = 0;

  updateManyMock.mockReset();
  updateManyMock.mockResolvedValue({ count: 1 });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);

  // Importa ANTES de ligar o fake timer (o loader do vite não deve correr com
  // o relógio congelado).
  modulo = await import('./webhook-delivery.worker.js');

  vi.useFakeTimers();
  vi.setSystemTime(RELOGIO);

  modulo.initWebhookDeliveryWorker(URL_REDIS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('initWebhookDeliveryWorker — fila, concorrência e conexão', () => {
  it('registra a fila "webhook-delivery"', () => {
    expect(capturado.nome).toBe('webhook-delivery');
  });

  it('usa concorrência 5 e NÃO configura limiter', () => {
    const opts = capturado.opts as unknown as OptsWorker;
    expect(opts.concurrency).toBe(5);
    // Documentado: não há rate limiter — 5 entregas simultâneas por instância,
    // sem teto de requisições/segundo contra o destino.
    expect(capturado.opts).not.toHaveProperty('limiter');
  });

  it('extrai host, porta e senha da URL do Redis', () => {
    const opts = capturado.opts as unknown as OptsWorker;
    expect(opts.connection).toEqual({
      host: 'redis.example.com',
      port: 6380,
      username: 'default',
      password: 'senha-do-redis',
    });
  });

  it('cai para a porta 6379 quando a URL não traz porta, e senha vira undefined', () => {
    modulo.initWebhookDeliveryWorker('redis://localhost');
    const opts = capturado.opts as unknown as OptsWorker;
    expect(opts.connection.host).toBe('localhost');
    expect(opts.connection.port).toBe(6379);
    expect(opts.connection.password).toBeUndefined();
  });

  it('rediss:// vira opção de TLS — antes o esquema era descartado', () => {
    modulo.initWebhookDeliveryWorker('rediss://:apenas-senha@upstash.io:6379');
    const opts = capturado.opts as unknown as OptsWorker;
    expect(opts.connection).toEqual({
      host: 'upstash.io',
      port: 6379,
      password: 'apenas-senha',
      tls: {},
    });
  });

  it('registra exatamente um handler, do evento "failed"', () => {
    expect(capturado.handlers.map(([evento]) => evento)).toEqual(['failed']);
  });

  it('devolve a instância do Worker que acabou de construir', () => {
    // Sem esta afirmação, trocar `return worker` por `return null as never`
    // deixaria a suíte inteira verde: nenhum outro teste olha o retorno (o
    // `index.ts` também o ignora). A assinatura promete um Worker, então
    // quem vier a usá-lo depende disto.
    const devolvido = modulo.initWebhookDeliveryWorker('redis://localhost:6379');
    expect(devolvido).toBe(capturado.instancia);
  });
});

describe('assinatura HMAC (X-Signature-256)', () => {
  it('assina `${timestamp}.${body}` e envia no formato sha256=<hex>', async () => {
    await processador()(jobFalso({ data: { secret: 'segredo-legado-em-claro' } }));

    const init = initDoFetch();
    const esperada = assinar(
      'segredo-legado-em-claro',
      init.headers['X-Webhook-Timestamp'],
      init.body,
    );
    expect(init.headers['X-Signature-256']).toBe(`sha256=${esperada}`);
    expect(init.headers['X-Signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('usa o relógio em SEGUNDOS (não ms) no X-Webhook-Timestamp', async () => {
    await processador()(jobFalso());
    expect(initDoFetch().headers['X-Webhook-Timestamp']).toBe(String(TS_ESPERADO));
  });

  it('assina exatamente o corpo que foi enviado', async () => {
    await processador()(jobFalso({ data: { payload: { a: 1, b: [2, 3] } } }));

    const init = initDoFetch();
    // Prova que o body assinado === body enviado: qualquer reserialização
    // (ordem de chaves, espaços) quebraria a verificação do consumidor.
    expect(init.body).toBe(JSON.stringify({ a: 1, b: [2, 3] }));
    const esperada = assinar(
      'segredo-legado-em-claro',
      String(TS_ESPERADO),
      JSON.stringify({ a: 1, b: [2, 3] }),
    );
    expect(init.headers['X-Signature-256']).toBe(`sha256=${esperada}`);
  });

  it('assinatura muda quando o timestamp muda (replay não reaproveita)', async () => {
    await processador()(jobFalso());
    const primeira = initDoFetch().headers['X-Signature-256'];

    vi.setSystemTime(new Date(RELOGIO.getTime() + 60_000));
    await processador()(jobFalso());
    expect(initDoFetch(1).headers['X-Signature-256']).not.toBe(primeira);
  });
});

describe('segredo cifrado no job (envelope gcm$)', () => {
  it('decifra o envelope e assina com o texto em claro', async () => {
    const { encrypt } = await import('../lib/secret-cipher.js');
    const envelope = encrypt('segredo-real');
    expect(envelope).toMatch(/^gcm\$/);

    await processador()(jobFalso({ data: { secret: envelope } }));

    const init = initDoFetch();
    const esperada = assinar('segredo-real', init.headers['X-Webhook-Timestamp'], init.body);
    expect(init.headers['X-Signature-256']).toBe(`sha256=${esperada}`);
  });

  it('a assinatura NÃO bate se calculada com o envelope como chave', async () => {
    const { encrypt } = await import('../lib/secret-cipher.js');
    const envelope = encrypt('segredo-real');

    await processador()(jobFalso({ data: { secret: envelope } }));

    const init = initDoFetch();
    const comEnvelope = assinar(envelope, init.headers['X-Webhook-Timestamp'], init.body);
    expect(init.headers['X-Signature-256']).not.toBe(`sha256=${comEnvelope}`);
  });

  it('nem o envelope nem o segredo em claro aparecem na URL, headers ou corpo', async () => {
    const { encrypt } = await import('../lib/secret-cipher.js');
    const envelope = encrypt('segredo-real');

    await processador()(jobFalso({ data: { secret: envelope } }));

    const init = initDoFetch();
    const enviado = urlDoFetch() + JSON.stringify(init.headers) + init.body;
    expect(enviado).not.toContain(envelope);
    expect(enviado).not.toContain('segredo-real');
    expect(enviado).not.toContain('gcm$');
  });

  it('dual-read: segredo legado em texto claro (sem gcm$) também assina', async () => {
    await processador()(jobFalso({ data: { secret: 'texto-puro-do-banco' } }));

    const init = initDoFetch();
    const esperada = assinar('texto-puro-do-banco', init.headers['X-Webhook-Timestamp'], init.body);
    expect(init.headers['X-Signature-256']).toBe(`sha256=${esperada}`);
  });
});

describe('requisição HTTP (método, headers e corpo)', () => {
  it('faz POST na url do job com o conjunto exato de headers', async () => {
    await processador()(jobFalso({ id: 'entrega-42' }));

    expect(urlDoFetch()).toBe('https://destino.example.com/hook');
    const init = initDoFetch();
    expect(init.method).toBe('POST');
    // O valor da assinatura é conferido nos testes de HMAC; aqui só o formato.
    // Comparar `init.headers['X-Signature-256']` consigo mesmo seria tautologia
    // — e pior: o `toEqual` ignora propriedade de valor `undefined`, então o
    // teste passaria se a rota parasse de mandar o header.
    expect(init.headers['X-Signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);

    const { 'X-Signature-256': _assinatura, ...demais } = init.headers;
    expect(demais).toEqual({
      'Content-Type': 'application/json',
      'X-Webhook-Event': 'row.created',
      'X-Webhook-Delivery-Id': 'clx0entrega0padrao',
      'X-Webhook-Timestamp': String(TS_ESPERADO),
    });
  });

  it('X-Webhook-Event vem de job.data.event (não de job.name)', async () => {
    await processador()(
      jobFalso({ name: 'nome-do-job', data: { event: 'rows.cleared' } }),
    );
    expect(initDoFetch().headers['X-Webhook-Event']).toBe('rows.cleared');
  });

  it('X-Webhook-Delivery-Id manda o id da ENTREGA, não o do job do BullMQ', async () => {
    // Antes mandava `job.id ?? ''` — um contador sequencial da fila, reciclável
    // entre limpezas. Consumidor que usasse esse header para idempotência
    // podia deduplicar entregas distintas.
    await processador()(
      jobFalso({ id: '77', data: { deliveryId: 'clx0entrega0abc' } }),
    );
    expect(initDoFetch().headers['X-Webhook-Delivery-Id']).toBe('clx0entrega0abc');
  });

  it('corpo é JSON.stringify(payload)', async () => {
    await processador()(jobFalso({ data: { payload: { x: null, y: 'ç' } } }));
    expect(initDoFetch().body).toBe('{"x":null,"y":"ç"}');
  });
});

describe('sucesso (response.ok)', () => {
  it('grava status success com attempts e responseCode, e não lança', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });

    await expect(processador()(jobFalso({ attemptsMade: 2 }))).resolves.toBeUndefined();

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(argsUpdate().data).toEqual({ status: 'success', attempts: 3, responseCode: 201 });
  });

  it('atualiza a linha certa: filtra pelo deliveryId do payload', async () => {
    // Este é o teste que fecha o defeito. Antes o filtro era
    // `{ subscriptionId, id: job.id }` — e `job.id` é o contador do BullMQ
    // ('1', '2', '3'…), enquanto o `WebhookDelivery.id` é um cuid do Prisma.
    // Os dois nunca casavam, o updateMany atingia ZERO linhas, e toda entrega
    // ficava 'pending' para sempre no histórico do dashboard — inclusive as
    // entregues com 200.
    await processador()(
      jobFalso({ id: '3', data: { deliveryId: 'clx0entrega0abc' } }),
    );

    expect(argsUpdate().where).toEqual({
      id: 'clx0entrega0abc',
      subscriptionId: 'sub-1',
    });
  });

  it('o filtro NÃO usa o job.id do BullMQ', async () => {
    // Guarda-corpo contra a regressão exata: se alguém trocar `deliveryId` por
    // `job.id` de novo, o `where.id` passa a ser '3' e este teste quebra.
    await processador()(
      jobFalso({ id: '3', data: { deliveryId: 'clx0entrega0abc' } }),
    );
    expect(argsUpdate().where.id).not.toBe('3');
  });

  it('o subscriptionId continua no filtro — defesa contra id de outra assinatura', async () => {
    await processador()(jobFalso({ data: { deliveryId: 'entrega-x' } }));
    expect(argsUpdate().where.subscriptionId).toBe('sub-1');
  });
});

describe('resposta não-ok do destino', () => {
  it('500 numa tentativa intermediária grava pending + responseCode, e lança', async () => {
    // O status reflete que AINDA HÁ retentativa; o responseCode registra o que
    // o destino respondeu. Antes eram duas escritas: a primeira gravava
    // 'failed' e a segunda reescrevia para 'pending' — o mesmo estado final, ao
    // custo de duas idas ao Postgres por entrega falhada.
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(processador()(jobFalso())).rejects.toThrow('Webhook returned 500');

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(argsUpdate(0).data).toEqual({ status: 'pending', attempts: 1, responseCode: 500 });
  });

  it('uma escrita por tentativa, não duas', async () => {
    // Guarda-corpo contra a regressão: se o `throw` voltar a cair no próprio
    // catch, este teste acusa.
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(processador()(jobFalso({ attemptsMade: 1 }))).rejects.toThrow();

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(argsUpdate(0).data).toEqual({ status: 'pending', attempts: 2, responseCode: 500 });
  });

  it('na última tentativa (attemptsMade 4) grava failed, com o responseCode', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await expect(processador()(jobFalso({ attemptsMade: 4 }))).rejects.toThrow(
      'Webhook returned 503',
    );

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(argsUpdate(0).data).toEqual({ status: 'failed', attempts: 5, responseCode: 503 });
  });

  it('404 também é falha (só response.ok conta)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(processador()(jobFalso())).rejects.toThrow('Webhook returned 404');
    expect(argsUpdate(0).data.responseCode).toBe(404);
  });
});

describe('erro de rede (fetch rejeita)', () => {
  it('1ª tentativa (attemptsMade 0) grava pending, sem responseCode, e relança', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(processador()(jobFalso())).rejects.toThrow('ECONNREFUSED');

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(argsUpdate().data).toEqual({ status: 'pending', attempts: 1 });
  });

  it('fronteira: attemptsMade 3 (4ª tentativa) ainda grava pending', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));

    await expect(processador()(jobFalso({ attemptsMade: 3 }))).rejects.toThrow('timeout');
    expect(argsUpdate().data).toEqual({ status: 'pending', attempts: 4 });
  });

  it('fronteira: attemptsMade 4 (5ª e última) grava failed', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));

    await expect(processador()(jobFalso({ attemptsMade: 4 }))).rejects.toThrow('timeout');
    expect(argsUpdate().data).toEqual({ status: 'failed', attempts: 5 });
  });

  it('o update do catch usa o mesmo filtro por deliveryId', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));

    await expect(
      processador()(jobFalso({ id: '9', data: { deliveryId: 'entrega-do-catch' } })),
    ).rejects.toThrow('timeout');

    expect(argsUpdate().where).toEqual({
      id: 'entrega-do-catch',
      subscriptionId: 'sub-1',
    });
  });

  it('falha do updateMany no catch NÃO mascara o erro original do fetch', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    updateManyMock.mockRejectedValue(new Error('P1001: banco inalcançável'));

    await expect(processador()(jobFalso())).rejects.toThrow('socket hang up');
  });
});

describe('timeout de 10s (AbortController)', () => {
  it('passa um AbortSignal ao fetch, ainda não abortado', async () => {
    await processador()(jobFalso());
    const sinal = initDoFetch().signal;
    expect(sinal).toBeInstanceOf(AbortSignal);
    expect(sinal.aborted).toBe(false);
  });

  it('aborta o sinal em 10s quando o destino não responde', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    const pendente = processador()(jobFalso());
    pendente.catch(() => {}); // nunca resolve; evita unhandled rejection

    const sinal = initDoFetch().signal;
    expect(sinal.aborted).toBe(false);
    // Âncora dos dois testes seguintes: com o fetch pendente existe 1 timer
    // armado — logo, contar 0 depois de concluir prova que o clearTimeout rodou.
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(sinal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(sinal.aborted).toBe(true);
  });

  it('limpa o timer no caminho de sucesso (finally)', async () => {
    await processador()(jobFalso());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limpa o timer no caminho de erro (finally)', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    await expect(processador()(jobFalso())).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('handler do evento "failed"', () => {
  it('loga jobId, subscriptionId, event, attempt e a mensagem do erro', () => {
    const registro = capturado.handlers[0];
    if (!registro) throw new Error('nenhum handler registrado');
    const [, handler] = registro as [string, Handler];

    handler(jobFalso({ id: 'entrega-7', attemptsMade: 2 }), new Error('destino fora do ar'));

    expect(logErro).toHaveBeenCalledTimes(1);
    expect(argDaChamada<Record<string, unknown>>(logErro)).toEqual({
      jobId: 'entrega-7',
      subscriptionId: 'sub-1',
      event: 'row.created',
      attempt: 2,
      err: 'destino fora do ar',
    });
    expect(argDaChamada<string>(logErro, 0, 1)).toBe('Delivery failed');
  });

  it('não loga (nem estoura) quando o job vem undefined', () => {
    const registro = capturado.handlers[0];
    if (!registro) throw new Error('nenhum handler registrado');
    const [, handler] = registro as [string, Handler];

    expect(() => handler(undefined, new Error('x'))).not.toThrow();
    expect(logErro).not.toHaveBeenCalled();
  });
});

describe('closeWebhookDeliveryWorker', () => {
  it('fecha o worker', async () => {
    await modulo.closeWebhookDeliveryWorker();
    expect(capturado.fechados).toBe(1);
  });

  it('chamar duas vezes não estoura e fecha só uma vez (zera o singleton)', async () => {
    await modulo.closeWebhookDeliveryWorker();
    await expect(modulo.closeWebhookDeliveryWorker()).resolves.toBeUndefined();
    expect(capturado.fechados).toBe(1);
  });

  it('é no-op quando nunca houve init', async () => {
    vi.useRealTimers();
    vi.resetModules();
    const fresco = await import('./webhook-delivery.worker.js');
    capturado.fechados = 0;

    await expect(fresco.closeWebhookDeliveryWorker()).resolves.toBeUndefined();
    expect(capturado.fechados).toBe(0);
  });
});
