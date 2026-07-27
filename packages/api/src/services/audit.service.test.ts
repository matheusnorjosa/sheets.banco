/**
 * Testes de caracterização de `services/audit.service.ts`.
 *
 * Por que este arquivo merece teste: o serviço é a trilha de auditoria — o
 * registro de quem mexeu em quê — e estava com 0% de cobertura. Ele guarda
 * as entradas num buffer de módulo e grava em lote, o que concentra três
 * riscos silenciosos:
 *
 *   1. Perda de trilha: se o lote não drenar ou o timer não recriar depois do
 *      shutdown, eventos somem sem ninguém perceber (o `catch` é mudo).
 *   2. Custo/latência: o `setInterval` de 2s roda para sempre; sem o guard de
 *      buffer vazio, o Postgres serverless seria acordado a cada 2 segundos.
 *   3. Mapeamento de colunas: opcionais ausentes viram `null`, MENOS `changes`,
 *      que vira `undefined`. A assimetria é proposital (o Prisma trata `null`
 *      em coluna Json como "grave JSON null") e precisa ficar travada.
 *
 * Só o `prisma` é mockado. O buffer, o timer e o mapeamento — o que o teste
 * precisa provar — rodam de verdade.
 *
 * ESTADO DE MÓDULO: `buffer` e `flushTimer` são variáveis de módulo e vazam
 * entre testes. Daí o `vi.resetModules()` + `await import(...)` no `beforeEach`
 * e o `flushAuditLog()` no `afterEach`, que mata o `setInterval`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { argDaChamada } from '../test-utils/app.js';

// `vi.mock` é içado acima dos imports — `vi.hoisted` compartilha o espião com
// a factory e mantém a referência para as asserções.
const { createManyMock } = vi.hoisted(() => ({
  createManyMock: vi.fn<(args: { data: LinhaAudit[] }) => Promise<{ count: number }>>(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    auditLog: { createMany: createManyMock },
  },
}));

/** Formato de cada linha entregue ao `createMany` (o que o teste inspeciona). */
interface LinhaAudit {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  sheetApiId: string | null;
  changes: unknown;
  ip: string | null;
  userAgent: string | null;
}

type ServicoAudit = typeof import('./audit.service.js');

const INTERVALO_MS = 2000;
const LIMITE_LOTE = 50;

const entradaBase = {
  actorId: 'user-1',
  action: 'sheetApi.update',
  resourceType: 'SheetApi',
  resourceId: 'api-1',
};

let servico: ServicoAudit | null = null;

/** Lê o lote de uma chamada do `createMany` com tipo. */
function loteDaChamada(chamada = 0): LinhaAudit[] {
  return argDaChamada<{ data: LinhaAudit[] }>(createManyMock, chamada).data;
}

/** Primeira linha do lote — evita o `possibly undefined` do índice. */
function primeiraLinha(chamada = 0): LinhaAudit {
  const [linha] = loteDaChamada(chamada);
  if (!linha) throw new Error('Esperava ao menos uma linha no lote.');
  return linha;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  createManyMock.mockReset();
  createManyMock.mockResolvedValue({ count: 0 });
  // Recarrega o módulo para zerar `buffer` e `flushTimer`.
  vi.resetModules();
  servico = await import('./audit.service.js');
});

afterEach(async () => {
  // Mata o `setInterval` que os testes deixaram vivo — senão o vitest não
  // encerra e o estado vaza para o próximo caso.
  await servico?.flushAuditLog();
  servico = null;
  vi.useRealTimers();
});

describe('audit — buffer e janela de 2s', () => {
  it('não grava na hora com uma única entrada', async () => {
    const { audit } = await import('./audit.service.js');

    audit(entradaBase);

    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('grava depois de avançar os 2s do timer', async () => {
    const { audit } = await import('./audit.service.js');

    audit(entradaBase);
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);

    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(loteDaChamada()).toHaveLength(1);
  });

  it('ainda não gravou 1ms antes do tick', async () => {
    const { audit } = await import('./audit.service.js');

    audit(entradaBase);
    await vi.advanceTimersByTimeAsync(INTERVALO_MS - 1);

    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('junta as entradas da mesma janela num único lote, na ordem de chegada', async () => {
    const { audit } = await import('./audit.service.js');

    audit({ ...entradaBase, resourceId: 'api-1' });
    audit({ ...entradaBase, resourceId: 'api-2' });
    audit({ ...entradaBase, resourceId: 'api-3' });
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);

    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(loteDaChamada().map((l) => l.resourceId)).toEqual(['api-1', 'api-2', 'api-3']);
  });

  it('cria um único setInterval, não um por chamada', async () => {
    const { audit } = await import('./audit.service.js');

    audit(entradaBase);
    audit(entradaBase);
    audit(entradaBase);

    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('audit — fronteira do lote de 50', () => {
  it('49 entradas NÃO disparam o flush', async () => {
    const { audit } = await import('./audit.service.js');

    for (let i = 0; i < LIMITE_LOTE - 1; i++) audit(entradaBase);

    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('a 50ª entrada dispara o flush na hora, sem esperar o timer', async () => {
    const { audit } = await import('./audit.service.js');

    for (let i = 0; i < LIMITE_LOTE - 1; i++) audit(entradaBase);
    expect(createManyMock).not.toHaveBeenCalled();

    audit(entradaBase); // 50ª

    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(loteDaChamada()).toHaveLength(LIMITE_LOTE);
  });

  it('o timer segue vivo depois do flush por lote (não há early return)', async () => {
    const { audit } = await import('./audit.service.js');

    for (let i = 0; i < LIMITE_LOTE; i++) audit(entradaBase);
    expect(vi.getTimerCount()).toBe(1);

    // Buffer drenado: o tick seguinte não grava nada.
    createManyMock.mockClear();
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);
    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('só volta a disparar por lote depois de outras 50 entradas', async () => {
    const { audit } = await import('./audit.service.js');

    for (let i = 0; i < LIMITE_LOTE; i++) audit(entradaBase);
    expect(createManyMock).toHaveBeenCalledTimes(1);

    for (let i = 0; i < LIMITE_LOTE - 1; i++) audit(entradaBase);
    expect(createManyMock).toHaveBeenCalledTimes(1);

    audit(entradaBase); // 100ª no total
    expect(createManyMock).toHaveBeenCalledTimes(2);
    expect(loteDaChamada(1)).toHaveLength(LIMITE_LOTE);
  });
});

describe('audit — drenagem do buffer (guard do banco serverless)', () => {
  it('depois do flush o buffer fica vazio e o tick seguinte não chama o createMany', async () => {
    const { audit } = await import('./audit.service.js');

    audit(entradaBase);
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);
    expect(createManyMock).toHaveBeenCalledTimes(1);

    createManyMock.mockClear();
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);

    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('30 ticks ociosos seguidos não acordam o banco', async () => {
    const { audit } = await import('./audit.service.js');

    audit(entradaBase);
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);
    createManyMock.mockClear();

    await vi.advanceTimersByTimeAsync(INTERVALO_MS * 30);

    expect(createManyMock).not.toHaveBeenCalled();
    // O timer continua armado, apenas ocioso.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('uma entrada nova depois do período ocioso volta a ser gravada', async () => {
    const { audit } = await import('./audit.service.js');

    audit(entradaBase);
    await vi.advanceTimersByTimeAsync(INTERVALO_MS * 10);
    createManyMock.mockClear();

    audit({ ...entradaBase, resourceId: 'api-tardia' });
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);

    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(primeiraLinha().resourceId).toBe('api-tardia');
  });
});

describe('audit — mapeamento das colunas', () => {
  it('preserva todos os campos quando a entrada vem completa', async () => {
    const { audit } = await import('./audit.service.js');
    const changes = { nome: { old: 'antigo', new: 'novo' } };

    audit({
      actorId: 'user-9',
      action: 'sheetApi.delete',
      resourceType: 'SheetApi',
      resourceId: 'api-9',
      sheetApiId: 'sheet-9',
      changes,
      ip: '203.0.113.7',
      userAgent: 'curl/8.0',
    });
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);

    expect(primeiraLinha()).toStrictEqual({
      actorId: 'user-9',
      action: 'sheetApi.delete',
      resourceType: 'SheetApi',
      resourceId: 'api-9',
      sheetApiId: 'sheet-9',
      changes,
      ip: '203.0.113.7',
      userAgent: 'curl/8.0',
    });
  });

  it('opcionais ausentes viram null — sheetApiId, ip e userAgent', async () => {
    const { audit } = await import('./audit.service.js');

    audit(entradaBase);
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);

    const linha = primeiraLinha();
    expect(linha.sheetApiId).toBeNull();
    expect(linha.ip).toBeNull();
    expect(linha.userAgent).toBeNull();
  });

  it('changes ausente vira undefined, NÃO null (assimetria proposital)', async () => {
    const { audit } = await import('./audit.service.js');

    audit(entradaBase);
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);

    const linha = primeiraLinha();
    expect(linha.changes).toBeUndefined();
    expect(linha.changes).not.toBeNull();
    // A chave existe no objeto, com valor undefined — é o que o Prisma lê
    // como "não mexa nesta coluna".
    expect(Object.prototype.hasOwnProperty.call(linha, 'changes')).toBe(true);
  });

  it('changes explicitamente null também vira undefined (o ?? engole o null)', async () => {
    const { audit } = await import('./audit.service.js');

    audit({ ...entradaBase, changes: null });
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);

    expect(primeiraLinha().changes).toBeUndefined();
  });

  it('não inventa campos: o objeto gravado tem exatamente as 8 colunas', async () => {
    const { audit } = await import('./audit.service.js');

    audit(entradaBase);
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);

    expect(Object.keys(primeiraLinha()).sort()).toEqual([
      'action',
      'actorId',
      'changes',
      'ip',
      'resourceId',
      'resourceType',
      'sheetApiId',
      'userAgent',
    ]);
  });
});

describe('audit — falha do banco', () => {
  it('createMany rejeitando não lança e não trava o timer', async () => {
    const { audit } = await import('./audit.service.js');
    createManyMock.mockRejectedValueOnce(new Error('conexão recusada'));

    audit(entradaBase);
    // Se o `catch` do flush não engolisse, o tick viraria rejeição não tratada
    // e o vitest derrubaria o teste aqui.
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);
    expect(createManyMock).toHaveBeenCalledTimes(1);

    // O timer sobreviveu: a próxima entrada é gravada no tick seguinte.
    audit({ ...entradaBase, resourceId: 'api-depois-do-erro' });
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);

    expect(createManyMock).toHaveBeenCalledTimes(2);
    expect(primeiraLinha(1).resourceId).toBe('api-depois-do-erro');
  });

  it('a entrada do lote que falhou é PERDIDA — o buffer já foi drenado', async () => {
    const { audit } = await import('./audit.service.js');
    createManyMock.mockRejectedValueOnce(new Error('conexão recusada'));

    audit({ ...entradaBase, resourceId: 'api-perdida' });
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);
    createManyMock.mockClear();

    // Sem retry e sem re-enfileirar: o tick seguinte não tenta de novo.
    await vi.advanceTimersByTimeAsync(INTERVALO_MS * 5);

    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('o erro do lote de 50 também é engolido de forma síncrona', async () => {
    const { audit } = await import('./audit.service.js');
    createManyMock.mockRejectedValueOnce(new Error('conexão recusada'));

    expect(() => {
      for (let i = 0; i < LIMITE_LOTE; i++) audit(entradaBase);
    }).not.toThrow();
    expect(createManyMock).toHaveBeenCalledTimes(1);
  });
});

describe('flushAuditLog — desligamento', () => {
  it('grava o que restou e limpa o setInterval', async () => {
    const { audit, flushAuditLog } = await import('./audit.service.js');

    audit(entradaBase);
    audit(entradaBase);
    expect(vi.getTimerCount()).toBe(1);

    await flushAuditLog();

    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(loteDaChamada()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('depois do flush os ticks não voltam — o intervalo foi mesmo cancelado', async () => {
    const { audit, flushAuditLog } = await import('./audit.service.js');

    audit(entradaBase);
    await flushAuditLog();
    createManyMock.mockClear();

    await vi.advanceTimersByTimeAsync(INTERVALO_MS * 10);

    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('com buffer vazio não chama o createMany (mas segue seguro de chamar)', async () => {
    const { flushAuditLog } = await import('./audit.service.js');

    await expect(flushAuditLog()).resolves.toBeUndefined();

    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('chamado duas vezes seguidas é idempotente', async () => {
    const { audit, flushAuditLog } = await import('./audit.service.js');

    audit(entradaBase);
    await flushAuditLog();
    await flushAuditLog();

    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('não lança se o createMany falhar durante o desligamento', async () => {
    const { audit, flushAuditLog } = await import('./audit.service.js');
    createManyMock.mockRejectedValueOnce(new Error('banco já fechou'));

    audit(entradaBase);

    await expect(flushAuditLog()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('um audit novo depois do flush RECRIA o timer', async () => {
    const { audit, flushAuditLog } = await import('./audit.service.js');

    audit(entradaBase);
    await flushAuditLog();
    expect(vi.getTimerCount()).toBe(0);
    createManyMock.mockClear();

    audit({ ...entradaBase, resourceId: 'api-pos-shutdown' });

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVALO_MS);
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(primeiraLinha().resourceId).toBe('api-pos-shutdown');
  });
});
