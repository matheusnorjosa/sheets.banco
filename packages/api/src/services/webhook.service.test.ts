/**
 * Testes de caracterização de `services/webhook.service.ts`.
 *
 * São 5 statements, mas com uma decisão forte escondida: **todo erro é
 * engolido** (`catch {}`). Isso é de propósito — o dispatch roda no caminho da
 * escrita na planilha (`workers/sheets-write.worker.ts:68`, aliás sem `await`),
 * e uma assinatura de webhook quebrada não pode derrubar a escrita. Os testes
 * abaixo travam esse contrato e, junto, dois detalhes que só aparecem lendo o
 * código:
 *
 *   1. o filtro `events: { has: evento }` — é o que impede uma assinatura de
 *      `row.created` de ser acordada por um `row.deleted`;
 *   2. o `for` está DENTRO do `try`: se a entrega da 1ª assinatura falhar, as
 *      seguintes **não** são processadas (ver `it` correspondente).
 *
 * O Prisma e a fila são mockados (o alvo é a lógica do serviço), mas o
 * `secret-cipher` é REAL: o ponto do último teste é justamente que o serviço
 * **não** decifra o secret, e mockar a cifra apagaria a prova.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

const { findManyMock, criarEntregaMock, enfileirarMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  criarEntregaMock: vi.fn(),
  enfileirarMock: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    webhookSubscription: { findMany: findManyMock },
    webhookDelivery: { create: criarEntregaMock },
  },
}));

vi.mock('../queues/webhook-delivery.queue.js', () => ({
  enqueueWebhookDelivery: enfileirarMock,
}));

import { dispatchWebhooks } from './webhook.service.js';
import { encrypt, decrypt } from '../lib/secret-cipher.js';
import { argDaChamada } from '../test-utils/app.js';

interface Assinatura {
  id: string;
  sheetApiId: string;
  url: string;
  secret: string;
  active: boolean;
  events: string[];
}

interface FiltroFindMany {
  where: {
    sheetApiId: string;
    active: boolean;
    events: { has: string };
  };
}

interface DadosEntrega {
  data: {
    subscriptionId: string;
    event: string;
    payload: Record<string, unknown>;
    status: string;
  };
}

interface JobDaFila {
  subscriptionId: string;
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
}

const API_ID = 'api-1';
const PAYLOAD = { row: 7, values: ['a', 'b'] };

function assinatura(over: Partial<Assinatura> = {}): Assinatura {
  return {
    id: 'sub-1',
    sheetApiId: API_ID,
    url: 'https://exemplo.test/hook',
    secret: 'segredo-cru',
    active: true,
    events: ['row.created'],
    ...over,
  };
}

/**
 * Tabela falsa que HONRA o `where` do Prisma. Sem ela o teste do `has` só
 * provaria que o objeto de filtro foi montado; com ela, prova o efeito —
 * assinatura de outro evento/API/inativa some do resultado.
 */
function tabelaFalsa(linhas: Assinatura[]) {
  return async (args: FiltroFindMany): Promise<Assinatura[]> =>
    linhas.filter(
      (l) =>
        l.sheetApiId === args.where.sheetApiId &&
        l.active === args.where.active &&
        l.events.includes(args.where.events.has),
    );
}

beforeAll(() => {
  // Chave só deste processo de teste. NUNCA um segredo real.
  process.env.SECRETS_ENC_KEY = crypto.randomBytes(32).toString('hex');
});

beforeEach(() => {
  vi.clearAllMocks();
  findManyMock.mockResolvedValue([]);
  criarEntregaMock.mockResolvedValue({ id: 'del-1' });
  enfileirarMock.mockResolvedValue(undefined);
});

describe('filtro das assinaturas', () => {
  it('busca por sheetApiId + active:true + events.has(evento)', async () => {
    await dispatchWebhooks(API_ID, 'row.updated', PAYLOAD);

    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(argDaChamada<FiltroFindMany>(findManyMock)).toEqual({
      where: {
        sheetApiId: API_ID,
        active: true,
        events: { has: 'row.updated' },
      },
    });
  });

  it('assinatura de row.created NÃO é acordada por row.deleted (o `has`)', async () => {
    findManyMock.mockImplementation(
      tabelaFalsa([assinatura({ id: 'sub-created', events: ['row.created'] })]),
    );

    await dispatchWebhooks(API_ID, 'row.deleted', PAYLOAD);

    expect(criarEntregaMock).not.toHaveBeenCalled();
    expect(enfileirarMock).not.toHaveBeenCalled();
  });

  it('assinatura com vários eventos é acordada por qualquer um deles', async () => {
    findManyMock.mockImplementation(
      tabelaFalsa([
        assinatura({ id: 'sub-multi', events: ['row.created', 'row.deleted', 'rows.cleared'] }),
      ]),
    );

    await dispatchWebhooks(API_ID, 'rows.cleared', PAYLOAD);

    expect(enfileirarMock).toHaveBeenCalledTimes(1);
    expect(argDaChamada<JobDaFila>(enfileirarMock).subscriptionId).toBe('sub-multi');
  });

  it('assinatura inativa é ignorada (active:true)', async () => {
    findManyMock.mockImplementation(
      tabelaFalsa([assinatura({ id: 'sub-off', active: false, events: ['row.created'] })]),
    );

    await dispatchWebhooks(API_ID, 'row.created', PAYLOAD);

    expect(enfileirarMock).not.toHaveBeenCalled();
  });

  it('assinatura de outra SheetApi é ignorada (sheetApiId)', async () => {
    findManyMock.mockImplementation(
      tabelaFalsa([assinatura({ id: 'sub-outra', sheetApiId: 'api-2' })]),
    );

    await dispatchWebhooks(API_ID, 'row.created', PAYLOAD);

    expect(enfileirarMock).not.toHaveBeenCalled();
  });
});

describe('entrega + enfileiramento', () => {
  it('cria o registro de entrega com status pending, evento e payload', async () => {
    findManyMock.mockResolvedValue([assinatura({ id: 'sub-A' })]);

    await dispatchWebhooks(API_ID, 'row.created', PAYLOAD);

    expect(criarEntregaMock).toHaveBeenCalledTimes(1);
    expect(argDaChamada<DadosEntrega>(criarEntregaMock)).toEqual({
      data: {
        subscriptionId: 'sub-A',
        event: 'row.created',
        payload: PAYLOAD,
        status: 'pending',
      },
    });
  });

  it('enfileira o job com subscriptionId, url, secret, evento e payload', async () => {
    findManyMock.mockResolvedValue([
      assinatura({ id: 'sub-A', url: 'https://destino.test/x', secret: 's3cr3t' }),
    ]);

    await dispatchWebhooks(API_ID, 'row.updated', PAYLOAD);

    expect(argDaChamada<JobDaFila>(enfileirarMock)).toEqual({
      subscriptionId: 'sub-A',
      url: 'https://destino.test/x',
      secret: 's3cr3t',
      event: 'row.updated',
      payload: PAYLOAD,
    });
  });

  it('com duas assinaturas: duas entregas e dois jobs, um por assinatura', async () => {
    findManyMock.mockResolvedValue([
      assinatura({ id: 'sub-A', url: 'https://a.test/h' }),
      assinatura({ id: 'sub-B', url: 'https://b.test/h' }),
    ]);

    await dispatchWebhooks(API_ID, 'row.created', PAYLOAD);

    expect(criarEntregaMock).toHaveBeenCalledTimes(2);
    expect(enfileirarMock).toHaveBeenCalledTimes(2);
    expect(argDaChamada<DadosEntrega>(criarEntregaMock, 0).data.subscriptionId).toBe('sub-A');
    expect(argDaChamada<DadosEntrega>(criarEntregaMock, 1).data.subscriptionId).toBe('sub-B');
    expect(argDaChamada<JobDaFila>(enfileirarMock, 0).url).toBe('https://a.test/h');
    expect(argDaChamada<JobDaFila>(enfileirarMock, 1).url).toBe('https://b.test/h');
  });

  it('processa em série: grava a entrega ANTES de enfileirar, assinatura a assinatura', async () => {
    findManyMock.mockResolvedValue([assinatura({ id: 'sub-A' }), assinatura({ id: 'sub-B' })]);

    await dispatchWebhooks(API_ID, 'row.created', PAYLOAD);

    const criacoes = criarEntregaMock.mock.invocationCallOrder;
    const envios = enfileirarMock.mock.invocationCallOrder;
    expect(criacoes[0]!).toBeLessThan(envios[0]!); // entrega da A antes do job da A
    expect(envios[0]!).toBeLessThan(criacoes[1]!); // A inteira antes de começar a B
    expect(criacoes[1]!).toBeLessThan(envios[1]!);
  });

  it('repassa o MESMO objeto de payload (por referência) ao banco e à fila', async () => {
    findManyMock.mockResolvedValue([assinatura({ id: 'sub-A' })]);

    await dispatchWebhooks(API_ID, 'row.created', PAYLOAD);

    expect(argDaChamada<DadosEntrega>(criarEntregaMock).data.payload).toBe(PAYLOAD);
    expect(argDaChamada<JobDaFila>(enfileirarMock).payload).toBe(PAYLOAD);
  });

  it('repassa o secret do banco COMO ESTÁ (cifrado) — quem decifra é o worker', async () => {
    const envelope = encrypt('segredo-hmac-do-cliente');
    findManyMock.mockResolvedValue([assinatura({ id: 'sub-A', secret: envelope })]);

    await dispatchWebhooks(API_ID, 'row.created', PAYLOAD);

    const job = argDaChamada<JobDaFila>(enfileirarMock);
    expect(job.secret).toBe(envelope);
    expect(job.secret).toMatch(/^gcm\$/);
    expect(job.secret).not.toBe('segredo-hmac-do-cliente');
    // E continua sendo o mesmo segredo, só que ainda cifrado.
    expect(decrypt(job.secret)).toBe('segredo-hmac-do-cliente');
  });
});

describe('nenhuma assinatura', () => {
  it('não cria entrega, não enfileira e não lança', async () => {
    findManyMock.mockResolvedValue([]);

    await expect(dispatchWebhooks(API_ID, 'row.created', PAYLOAD)).resolves.toBeUndefined();

    expect(criarEntregaMock).not.toHaveBeenCalled();
    expect(enfileirarMock).not.toHaveBeenCalled();
  });
});

describe('todo erro é engolido (webhook não derruba a escrita)', () => {
  it('findMany rejeitando: resolve sem lançar e nada é enfileirado', async () => {
    findManyMock.mockRejectedValue(new Error('conexão recusada'));

    await expect(dispatchWebhooks(API_ID, 'row.created', PAYLOAD)).resolves.toBeUndefined();

    expect(criarEntregaMock).not.toHaveBeenCalled();
    expect(enfileirarMock).not.toHaveBeenCalled();
  });

  it('webhookDelivery.create rejeitando: resolve e não enfileira nada', async () => {
    findManyMock.mockResolvedValue([assinatura({ id: 'sub-A' })]);
    criarEntregaMock.mockRejectedValue(new Error('unique violation'));

    await expect(dispatchWebhooks(API_ID, 'row.created', PAYLOAD)).resolves.toBeUndefined();

    expect(enfileirarMock).not.toHaveBeenCalled();
  });

  it('enqueue falhando na 1ª assinatura silencia a 2ª (o `for` está dentro do `try`)', async () => {
    findManyMock.mockResolvedValue([assinatura({ id: 'sub-A' }), assinatura({ id: 'sub-B' })]);
    enfileirarMock.mockRejectedValueOnce(new Error('redis fora do ar'));

    await expect(dispatchWebhooks(API_ID, 'row.created', PAYLOAD)).resolves.toBeUndefined();

    // A entrega da B nunca é gravada e o job da B nunca é criado: a exceção da
    // A pula o resto do laço. Comportamento REAL de hoje — não é o desejável.
    expect(criarEntregaMock).toHaveBeenCalledTimes(1);
    expect(enfileirarMock).toHaveBeenCalledTimes(1);
    expect(argDaChamada<JobDaFila>(enfileirarMock).subscriptionId).toBe('sub-A');
  });

  it('erro que não é Error (throw de string) também é engolido', async () => {
    findManyMock.mockImplementation(() => {
      throw 'boom';
    });

    await expect(dispatchWebhooks(API_ID, 'row.created', PAYLOAD)).resolves.toBeUndefined();
  });
});
