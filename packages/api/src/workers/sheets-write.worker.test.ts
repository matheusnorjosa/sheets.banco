/**
 * Testes de caracterização de `workers/sheets-write.worker.ts` (0% de cobertura).
 *
 * Este worker é o único caminho de ESCRITA na planilha do usuário: tudo que a
 * API grava passa por ele. Três coisas justificam travar o comportamento atual:
 *
 *   1. **Cota do Google.** `concurrency: 3` + `limiter: { max: 4, duration: 1000 }`
 *      é o que mantém a API abaixo dos 300 req/min do Sheets. Se alguém subir
 *      esses números "pra ficar mais rápido", o sintoma é 429 em produção, não
 *      teste vermelho — a menos que exista este teste.
 *   2. **Curto-circuito silencioso.** Job sem linhas (ou update sem `column`)
 *      retorna `{ created: 0 }` / `{ updated: 0 }` com um `return` antecipado
 *      que pula o despacho de webhook. É comportamento não óbvio e precisa
 *      estar escrito em algum lugar.
 *   3. **Mapa de eventos.** append→row.created, update→row.updated,
 *      delete→row.deleted, clear→rows.cleared é contrato com os assinantes de
 *      webhook: mudar uma string quebra integração de terceiro em silêncio.
 *
 * `processJob` é privada do módulo. Em vez de exportá-la (seria mudar o fonte),
 * o `bullmq` é mockado e a função processadora é capturada do 2º argumento do
 * construtor do `Worker` — que é exatamente o contrato que o BullMQ usa.
 *
 * O módulo guarda o worker em variável de módulo (`let worker = null`), estado
 * que vaza entre testes; por isso `vi.resetModules()` + `await import` no
 * `beforeEach`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SheetWriteResult } from '../queues/sheets-write.queue.js';

type Processador = (job: unknown) => Promise<SheetWriteResult>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerEvento = (...args: any[]) => void;

interface OpcoesWorker {
  connection: { host: string; port: number; password?: string };
  concurrency: number;
  limiter: { max: number; duration: number };
}

interface RegistroWorker {
  nome: string;
  processador: Processador;
  opts: OpcoesWorker;
  handlers: Map<string, HandlerEvento>;
  fechamentos: number;
}

const { estado, sheets, dispatchWebhooks, findFirst, log } = vi.hoisted(() => ({
  estado: { instancias: [] as Array<Record<string, unknown>> },
  sheets: {
    appendRows: vi.fn(),
    updateRows: vi.fn(),
    deleteRows: vi.fn(),
    clearAllRows: vi.fn(),
  },
  dispatchWebhooks: vi.fn(),
  findFirst: vi.fn(),
  log: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('bullmq', () => {
  class WorkerFalso {
    registro: RegistroWorker;
    constructor(nome: string, processador: Processador, opts: OpcoesWorker) {
      this.registro = { nome, processador, opts, handlers: new Map(), fechamentos: 0 };
      estado.instancias.push(this.registro as unknown as Record<string, unknown>);
    }
    on(evento: string, handler: HandlerEvento): this {
      this.registro.handlers.set(evento, handler);
      return this;
    }
    async close(): Promise<void> {
      this.registro.fechamentos += 1;
    }
  }
  return { Worker: WorkerFalso };
});

vi.mock('../services/google-sheets.service.js', () => sheets);
vi.mock('../services/webhook.service.js', () => ({ dispatchWebhooks }));
vi.mock('../lib/prisma.js', () => ({ prisma: { sheetApi: { findFirst } } }));
vi.mock('../lib/logger.js', () => ({ logger: { child: () => log } }));
// O env valida na importação e chama process.exit(1) sem DATABASE_URL.
vi.mock('../config/env.js', () => ({ env: { LOG_LEVEL: 'silent' } }));

const URL_REDIS = 'redis://usuario:senha-do-redis@redis.interno:6380';

let iniciar: (redisUrl: string) => unknown;
let fechar: () => Promise<void>;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  estado.instancias.length = 0;

  findFirst.mockResolvedValue({ id: 'api-1' });
  dispatchWebhooks.mockResolvedValue(undefined);
  sheets.appendRows.mockResolvedValue(0);
  sheets.updateRows.mockResolvedValue(0);
  sheets.deleteRows.mockResolvedValue(0);
  sheets.clearAllRows.mockResolvedValue(0);

  const mod = await import('./sheets-write.worker.js');
  iniciar = mod.initSheetsWriteWorker;
  fechar = mod.closeSheetsWriteWorker;
});

/** Último Worker construído — falha com mensagem útil se nenhum foi criado. */
function ultimoWorker(): RegistroWorker {
  const reg = estado.instancias[estado.instancias.length - 1];
  if (!reg) throw new Error('Nenhum Worker foi construído.');
  return reg as unknown as RegistroWorker;
}

/** Inicia o worker e devolve a função processadora capturada do construtor. */
function processadorDe(url: string = URL_REDIS): Processador {
  iniciar(url);
  return ultimoWorker().processador;
}

function jobFalso(data: Record<string, unknown>): unknown {
  return { id: 'job-1', name: String(data.type), data, attemptsMade: 0 };
}

const BASE = { userId: 'user-1', spreadsheetId: 'planilha-1', sheetName: 'Página1' };

describe('initSheetsWriteWorker — configuração da fila', () => {
  it('registra o worker na fila "sheets-write"', () => {
    iniciar(URL_REDIS);
    expect(ultimoWorker().nome).toBe('sheets-write');
  });

  it('trava concorrência 3 e limiter 4/1000 (proteção da cota do Google: 300/min)', () => {
    iniciar(URL_REDIS);
    const { opts } = ultimoWorker();
    expect(opts.concurrency).toBe(3);
    expect(opts.limiter).toEqual({ max: 4, duration: 1000 });
  });

  it('extrai host, porta e senha da URL do Redis', () => {
    iniciar(URL_REDIS);
    expect(ultimoWorker().opts.connection).toEqual({
      host: 'redis.interno',
      port: 6380,
      username: 'usuario',
      password: 'senha-do-redis',
    });
  });

  it('cai para a porta 6379 quando a URL não traz porta', () => {
    iniciar('redis://localhost');
    expect(ultimoWorker().opts.connection.port).toBe(6379);
  });

  it('manda password undefined quando a URL não traz senha (string vazia vira undefined)', () => {
    iniciar('redis://localhost:6379');
    expect(ultimoWorker().opts.connection.password).toBeUndefined();
  });

  it('preserva o usuário da URL — Redis 6+ com ACL autentica por usuário', () => {
    // Descartá-lo autenticava como `default`, que pode não ter as permissões
    // da fila.
    iniciar(URL_REDIS);
    expect(Object.keys(ultimoWorker().opts.connection).sort()).toEqual([
      'host',
      'password',
      'port',
      'username',
    ]);
  });

  it('registra os listeners completed e failed e devolve a instância', () => {
    const retorno = iniciar(URL_REDIS);
    expect(retorno).toBeDefined();
    expect([...ultimoWorker().handlers.keys()].sort()).toEqual(['completed', 'failed']);
  });

  it('chamar duas vezes cria um segundo Worker e abandona o primeiro (não fecha)', () => {
    iniciar(URL_REDIS);
    iniciar(URL_REDIS);
    expect(estado.instancias).toHaveLength(2);
    // O primeiro nunca é fechado: a variável de módulo é sobrescrita.
    expect((estado.instancias[0] as unknown as RegistroWorker).fechamentos).toBe(0);
  });
});

describe('listeners de log', () => {
  it('completed loga jobId, tipo e retorno do job', () => {
    iniciar(URL_REDIS);
    ultimoWorker().handlers.get('completed')?.({
      id: 'j-9',
      name: 'append',
      returnvalue: { created: 2 },
    });
    expect(log.info).toHaveBeenCalledWith(
      { jobId: 'j-9', type: 'append', result: { created: 2 } },
      'Job completed',
    );
  });

  it('completed sem job não loga nada', () => {
    iniciar(URL_REDIS);
    ultimoWorker().handlers.get('completed')?.(undefined);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('failed loga tentativa e mensagem do erro', () => {
    iniciar(URL_REDIS);
    ultimoWorker().handlers.get('failed')?.(
      { id: 'j-9', name: 'update', attemptsMade: 2 },
      new Error('cota estourada'),
    );
    expect(log.error).toHaveBeenCalledWith(
      { jobId: 'j-9', type: 'update', attempt: 2, err: 'cota estourada' },
      'Job failed',
    );
  });

  it('failed sem job não loga nada', () => {
    iniciar(URL_REDIS);
    ultimoWorker().handlers.get('failed')?.(undefined, new Error('x'));
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('processJob — append', () => {
  it('chama appendRows(userId, spreadsheetId, rows, sheetName) e devolve { created: N }', async () => {
    sheets.appendRows.mockResolvedValue(3);
    const processar = processadorDe();
    const rows = [{ nome: 'Ana' }, { nome: 'Bia' }, { nome: 'Cid' }];

    const resultado = await processar(jobFalso({ type: 'append', ...BASE, rows }));

    expect(sheets.appendRows).toHaveBeenCalledWith('user-1', 'planilha-1', rows, 'Página1');
    expect(resultado).toEqual({ created: 3 });
  });

  it('passa sheetName undefined quando o job não traz aba', async () => {
    sheets.appendRows.mockResolvedValue(1);
    const processar = processadorDe();

    await processar(
      jobFalso({ type: 'append', userId: 'u', spreadsheetId: 's', rows: [{ a: 1 }] }),
    );

    expect(sheets.appendRows).toHaveBeenCalledWith('u', 's', [{ a: 1 }], undefined);
  });

  it('sem rows: devolve { created: 0 }, não chama o Google e NÃO despacha webhook', async () => {
    const processar = processadorDe();

    const resultado = await processar(jobFalso({ type: 'append', ...BASE }));

    expect(resultado).toEqual({ created: 0 });
    expect(sheets.appendRows).not.toHaveBeenCalled();
    // O `return` antecipado pula o despacho: job vazio não gera evento.
    expect(findFirst).not.toHaveBeenCalled();
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });

  it('rows vazio ([]) tem o mesmo curto-circuito de rows ausente', async () => {
    const processar = processadorDe();

    const resultado = await processar(jobFalso({ type: 'append', ...BASE, rows: [] }));

    expect(resultado).toEqual({ created: 0 });
    expect(sheets.appendRows).not.toHaveBeenCalled();
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });
});

describe('processJob — update', () => {
  it('chama updateRows(userId, spreadsheetId, column, value, data, sheetName) e devolve { updated: N }', async () => {
    sheets.updateRows.mockResolvedValue(2);
    const processar = processadorDe();

    const resultado = await processar(
      jobFalso({ type: 'update', ...BASE, column: 'cpf', value: '123', data: { nome: 'Ana' } }),
    );

    expect(sheets.updateRows).toHaveBeenCalledWith(
      'user-1',
      'planilha-1',
      'cpf',
      '123',
      { nome: 'Ana' },
      'Página1',
    );
    expect(resultado).toEqual({ updated: 2 });
  });

  it('sem column: { updated: 0 } sem chamar nada', async () => {
    const processar = processadorDe();

    const resultado = await processar(
      jobFalso({ type: 'update', ...BASE, value: '123', data: { nome: 'Ana' } }),
    );

    expect(resultado).toEqual({ updated: 0 });
    expect(sheets.updateRows).not.toHaveBeenCalled();
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });

  it('sem value: { updated: 0 } sem chamar nada', async () => {
    const processar = processadorDe();

    const resultado = await processar(
      jobFalso({ type: 'update', ...BASE, column: 'cpf', data: { nome: 'Ana' } }),
    );

    expect(resultado).toEqual({ updated: 0 });
    expect(sheets.updateRows).not.toHaveBeenCalled();
  });

  it('sem data: { updated: 0 } sem chamar nada', async () => {
    const processar = processadorDe();

    const resultado = await processar(
      jobFalso({ type: 'update', ...BASE, column: 'cpf', value: '123' }),
    );

    expect(resultado).toEqual({ updated: 0 });
    expect(sheets.updateRows).not.toHaveBeenCalled();
  });

  it('value string vazia é tratado como ausente (guarda é falsy, não `== null`)', async () => {
    const processar = processadorDe();

    const resultado = await processar(
      jobFalso({ type: 'update', ...BASE, column: 'obs', value: '', data: { obs: 'x' } }),
    );

    expect(resultado).toEqual({ updated: 0 });
    expect(sheets.updateRows).not.toHaveBeenCalled();
  });

  it('data vazio ({}) também é considerado ausente? Não: objeto vazio é truthy e a escrita acontece', async () => {
    sheets.updateRows.mockResolvedValue(1);
    const processar = processadorDe();

    const resultado = await processar(
      jobFalso({ type: 'update', ...BASE, column: 'cpf', value: '123', data: {} }),
    );

    expect(resultado).toEqual({ updated: 1 });
    expect(sheets.updateRows).toHaveBeenCalled();
  });
});

describe('processJob — delete', () => {
  it('chama deleteRows(userId, spreadsheetId, column, value, sheetName) e devolve { deleted: N }', async () => {
    sheets.deleteRows.mockResolvedValue(5);
    const processar = processadorDe();

    const resultado = await processar(
      jobFalso({ type: 'delete', ...BASE, column: 'cpf', value: '123' }),
    );

    expect(sheets.deleteRows).toHaveBeenCalledWith(
      'user-1',
      'planilha-1',
      'cpf',
      '123',
      'Página1',
    );
    expect(resultado).toEqual({ deleted: 5 });
  });

  it('sem column: { deleted: 0 } sem chamar nada nem despachar', async () => {
    const processar = processadorDe();

    const resultado = await processar(jobFalso({ type: 'delete', ...BASE, value: '123' }));

    expect(resultado).toEqual({ deleted: 0 });
    expect(sheets.deleteRows).not.toHaveBeenCalled();
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });

  it('sem value: { deleted: 0 } sem chamar nada', async () => {
    const processar = processadorDe();

    const resultado = await processar(jobFalso({ type: 'delete', ...BASE, column: 'cpf' }));

    expect(resultado).toEqual({ deleted: 0 });
    expect(sheets.deleteRows).not.toHaveBeenCalled();
  });
});

describe('processJob — clear', () => {
  it('chama clearAllRows(userId, spreadsheetId, sheetName) e devolve { deleted: N }', async () => {
    sheets.clearAllRows.mockResolvedValue(42);
    const processar = processadorDe();

    const resultado = await processar(jobFalso({ type: 'clear', ...BASE }));

    expect(sheets.clearAllRows).toHaveBeenCalledWith('user-1', 'planilha-1', 'Página1');
    expect(resultado).toEqual({ deleted: 42 });
  });

  it('clear não tem guarda: sem sheetName limpa a planilha inteira mesmo assim', async () => {
    sheets.clearAllRows.mockResolvedValue(0);
    const processar = processadorDe();

    const resultado = await processar(
      jobFalso({ type: 'clear', userId: 'u', spreadsheetId: 's' }),
    );

    expect(sheets.clearAllRows).toHaveBeenCalledWith('u', 's', undefined);
    expect(resultado).toEqual({ deleted: 0 });
  });
});

describe('processJob — tipo desconhecido', () => {
  it('lança "Unknown job type: <tipo>" e não despacha webhook', async () => {
    const processar = processadorDe();

    await expect(processar(jobFalso({ type: 'upsert', ...BASE }))).rejects.toThrow(
      'Unknown job type: upsert',
    );
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });
});

describe('despacho de webhooks', () => {
  it('resolve a SheetApi por spreadsheetId + userId pedindo só o id', async () => {
    sheets.appendRows.mockResolvedValue(1);
    const processar = processadorDe();

    await processar(jobFalso({ type: 'append', ...BASE, rows: [{ a: 1 }] }));

    expect(findFirst).toHaveBeenCalledWith({
      where: { spreadsheetId: 'planilha-1', userId: 'user-1' },
      select: { id: true },
    });
  });

  const mapaDeEventos: Array<{ tipo: string; evento: string; extra: Record<string, unknown> }> = [
    { tipo: 'append', evento: 'row.created', extra: { rows: [{ a: 1 }] } },
    { tipo: 'update', evento: 'row.updated', extra: { column: 'c', value: 'v', data: { a: 1 } } },
    { tipo: 'delete', evento: 'row.deleted', extra: { column: 'c', value: 'v' } },
    { tipo: 'clear', evento: 'rows.cleared', extra: {} },
  ];

  for (const { tipo, evento, extra } of mapaDeEventos) {
    it(`${tipo} despacha o evento "${evento}" (contrato com os assinantes)`, async () => {
      const processar = processadorDe();

      await processar(jobFalso({ type: tipo, ...BASE, ...extra }));

      expect(dispatchWebhooks).toHaveBeenCalledTimes(1);
      const [sheetApiId, eventoDespachado] = dispatchWebhooks.mock.calls[0] ?? [];
      expect(sheetApiId).toBe('api-1');
      expect(eventoDespachado).toBe(evento);
    });
  }

  it('payload leva type, spreadsheetId, sheetName e o resultado da escrita', async () => {
    sheets.appendRows.mockResolvedValue(2);
    const processar = processadorDe();

    await processar(jobFalso({ type: 'append', ...BASE, rows: [{ a: 1 }, { a: 2 }] }));

    const payload = dispatchWebhooks.mock.calls[0]?.[2];
    expect(payload).toEqual({
      type: 'append',
      spreadsheetId: 'planilha-1',
      sheetName: 'Página1',
      result: { created: 2 },
    });
  });

  it('sheetName ausente vira null no payload (não undefined — sobrevive ao JSON)', async () => {
    sheets.clearAllRows.mockResolvedValue(7);
    const processar = processadorDe();

    await processar(jobFalso({ type: 'clear', userId: 'user-1', spreadsheetId: 'planilha-1' }));

    expect(dispatchWebhooks.mock.calls[0]?.[2]).toEqual({
      type: 'clear',
      spreadsheetId: 'planilha-1',
      sheetName: null,
      result: { deleted: 7 },
    });
  });

  it('sem SheetApi correspondente: não despacha, mas a escrita volta normal', async () => {
    findFirst.mockResolvedValue(null);
    sheets.appendRows.mockResolvedValue(4);
    const processar = processadorDe();

    const resultado = await processar(jobFalso({ type: 'append', ...BASE, rows: [{ a: 1 }] }));

    expect(resultado).toEqual({ created: 4 });
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });

  it('despacho é fire-and-forget: dispatchWebhooks rejeitado não derruba o job', async () => {
    dispatchWebhooks.mockRejectedValue(new Error('webhook fora do ar'));
    sheets.appendRows.mockResolvedValue(1);
    const processar = processadorDe();

    await expect(
      processar(jobFalso({ type: 'append', ...BASE, rows: [{ a: 1 }] })),
    ).resolves.toEqual({ created: 1 });
  });

  it('o job não espera o despacho: o resultado volta mesmo com o webhook pendente', async () => {
    let liberar: (() => void) | undefined;
    dispatchWebhooks.mockReturnValue(
      new Promise<void>((resolve) => {
        liberar = resolve;
      }),
    );
    sheets.appendRows.mockResolvedValue(1);
    const processar = processadorDe();

    const resultado = await processar(jobFalso({ type: 'append', ...BASE, rows: [{ a: 1 }] }));

    expect(resultado).toEqual({ created: 1 });
    liberar?.();
  });

  it('erro da escrita no Google propaga para o BullMQ (job falha e é reprocessado)', async () => {
    sheets.appendRows.mockRejectedValue(new Error('403 quota exceeded'));
    const processar = processadorDe();

    await expect(
      processar(jobFalso({ type: 'append', ...BASE, rows: [{ a: 1 }] })),
    ).rejects.toThrow('403 quota exceeded');
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });
});

describe('closeSheetsWriteWorker', () => {
  it('fecha o worker iniciado', async () => {
    iniciar(URL_REDIS);
    await fechar();
    expect(ultimoWorker().fechamentos).toBe(1);
  });

  it('chamar duas vezes não estoura e não fecha de novo (zera a referência)', async () => {
    iniciar(URL_REDIS);
    await fechar();
    await expect(fechar()).resolves.toBeUndefined();
    expect(ultimoWorker().fechamentos).toBe(1);
  });

  it('sem worker iniciado é no-op', async () => {
    await expect(fechar()).resolves.toBeUndefined();
    expect(estado.instancias).toHaveLength(0);
  });
});
