/**
 * Testes de caracterização de `services/cache.service.ts`.
 *
 * Por que este arquivo de 28 statements merece teste: ele é a única camada que
 * separa "Redis caiu" de "a API caiu". Todo `catch` aqui está vazio de
 * propósito — o contrato é **cache best-effort**: se o Redis some, expira o
 * comando ou devolve lixo, a requisição segue como se não houvesse cache.
 * Um refactor bem-intencionado que troque um `catch {}` por um `throw`
 * transforma indisponibilidade do Upstash em 500 em produção, e nada hoje
 * detectaria isso.
 *
 * Os testes travam também duas assimetrias reais do módulo (ver os describes
 * de `del` e as observações no fim): `del` não checa `status`, e `get` pode
 * devolver `null` apesar de a assinatura prometer `T | undefined`.
 *
 * Não há mock de Redis de verdade nem de `ioredis`: `initCache` aceita
 * qualquer objeto (`any`), então injetamos um dublê com `vi.fn()`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { argDaChamada } from '../test-utils/app.js';
import * as cache from './cache.service.js';

/** Dublê mínimo do cliente ioredis — só o que o cache.service consome. */
function criarRedisFalso(status = 'ready') {
  return {
    status,
    get: vi.fn<(chave: string) => Promise<string | null>>().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    scanStream: vi.fn().mockReturnValue(fluxoDeLotes([])),
  };
}

/**
 * `scanStream` do ioredis é um Readable consumido com `for await`. Aqui basta
 * um objeto async-iterable que entrega os lotes de chaves na ordem dada.
 */
function fluxoDeLotes(lotes: string[][]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const lote of lotes) yield lote;
    },
  };
}

let redis: ReturnType<typeof criarRedisFalso>;

beforeEach(() => {
  vi.clearAllMocks();
  redis = criarRedisFalso();
  cache.initCache(redis);
});

describe('sem Redis pronto — tudo vira no-op silencioso', () => {
  it('sem nunca chamar initCache, as quatro funções resolvem sem explodir', async () => {
    // `vi.resetModules()` dá um módulo virgem, com o `redis` interno ainda
    // null — o estado real do processo antes do plugin de Redis registrar.
    vi.resetModules();
    const virgem = await import('./cache.service.js');

    await expect(virgem.get('qualquer')).resolves.toBeUndefined();
    await expect(virgem.set('qualquer', { a: 1 }, 60)).resolves.toBeUndefined();
    await expect(virgem.invalidate('rows:')).resolves.toBeUndefined();
    await expect(virgem.del('qualquer')).resolves.toBeUndefined();
  });

  it('initCache(null) desliga o cache: get devolve undefined', async () => {
    cache.initCache(null);
    await expect(cache.get('chave')).resolves.toBeUndefined();
  });

  it.each(['connecting', 'connect', 'reconnecting', 'end', 'close'])(
    'com status "%s" (≠ ready), get não toca no Redis e devolve undefined',
    async (status) => {
      const redisNaoPronto = criarRedisFalso(status);
      cache.initCache(redisNaoPronto);

      await expect(cache.get('chave')).resolves.toBeUndefined();
      expect(redisNaoPronto.get).not.toHaveBeenCalled();
    },
  );

  it('com status "connecting", set é no-op: setex NÃO é chamado', async () => {
    const redisNaoPronto = criarRedisFalso('connecting');
    cache.initCache(redisNaoPronto);

    await cache.set('chave', { a: 1 }, 60);

    expect(redisNaoPronto.setex).not.toHaveBeenCalled();
  });

  it('com status "connecting", invalidate é no-op: scanStream NÃO é chamado', async () => {
    const redisNaoPronto = criarRedisFalso('connecting');
    cache.initCache(redisNaoPronto);

    await cache.invalidate('rows:planilha-1');

    expect(redisNaoPronto.scanStream).not.toHaveBeenCalled();
    expect(redisNaoPronto.del).not.toHaveBeenCalled();
  });
});

describe('get', () => {
  it('devolve o objeto desserializado quando o JSON é válido', async () => {
    redis.get.mockResolvedValue('{"nome":"Ana","idade":30}');

    const valor = await cache.get<{ nome: string; idade: number }>('sheetApi:api-1');

    expect(valor).toEqual({ nome: 'Ana', idade: 30 });
    expect(argDaChamada<string>(redis.get)).toBe('sheetApi:api-1');
  });

  it('chave inexistente (redis devolve null) → undefined', async () => {
    redis.get.mockResolvedValue(null);
    await expect(cache.get('nao-existe')).resolves.toBeUndefined();
  });

  it('string vazia gravada no Redis também vira undefined (curto-circuito em `!data`)', async () => {
    // O guard é `if (!data)`, não `if (data === null)`. Qualquer valor cru
    // falsy vindo do Redis é tratado como miss antes de chegar ao JSON.parse.
    redis.get.mockResolvedValue('');
    await expect(cache.get('vazia')).resolves.toBeUndefined();
  });

  it('JSON corrompido ("{{{") devolve undefined em vez de estourar', async () => {
    // Cenário real: entrada gravada por uma versão antiga do código, ou
    // truncada. Um throw aqui derrubaria a requisição que só queria ler cache.
    redis.get.mockResolvedValue('{{{');
    await expect(cache.get('corrompida')).resolves.toBeUndefined();
  });

  it('promise rejeitada pelo Redis (timeout/conexão) devolve undefined, sem throw', async () => {
    redis.get.mockRejectedValue(new Error('Connection is closed.'));
    await expect(cache.get('chave')).resolves.toBeUndefined();
  });

  it('ARMADILHA DE TIPO: valor "null" gravado volta como null, não undefined', async () => {
    // A assinatura promete `Promise<T | undefined>`, mas `JSON.parse('null')`
    // é `null` e o código devolve isso direto. Quem escreveu
    // `const x = await cache.get(k); if (x === undefined) buscarNoBanco()`
    // recebe `null` e segue adiante achando que tem dado. Documentado aqui
    // como está HOJE (ver `possiveisBugs` no relatório).
    redis.get.mockResolvedValue('null');
    const valor = await cache.get('gravada-como-null');

    expect(valor).toBeNull();
    expect(valor).not.toBeUndefined();
  });
});

describe('set', () => {
  it('serializa com JSON.stringify e chama setex(chave, ttl, json)', async () => {
    await cache.set('rows:planilha-1', [{ nome: 'Ana' }], 300);

    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(argDaChamada<string>(redis.setex, 0, 0)).toBe('rows:planilha-1');
    expect(argDaChamada<number>(redis.setex, 0, 1)).toBe(300);
    expect(argDaChamada<string>(redis.setex, 0, 2)).toBe('[{"nome":"Ana"}]');
  });

  it('TTL é repassado cru, sem piso nem teto (0 chega como 0)', async () => {
    await cache.set('chave', 'x', 0);
    expect(argDaChamada<number>(redis.setex, 0, 1)).toBe(0);
  });

  it('erro do Redis é engolido: a promise resolve normalmente', async () => {
    redis.setex.mockRejectedValue(new Error('READONLY You cannot write against a read only replica'));
    await expect(cache.set('chave', { a: 1 }, 60)).resolves.toBeUndefined();
  });

  it('ARMADILHA: gravar `undefined` manda `undefined` (não string) para o setex', async () => {
    // `JSON.stringify(undefined)` é `undefined`, não `"undefined"` nem `"null"`.
    // O ioredis recebe um argumento não-string. O comportamento atual é este;
    // nenhum chamador de hoje passa undefined, mas nada impede.
    await cache.set('chave', undefined, 60);

    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(argDaChamada<unknown>(redis.setex, 0, 2)).toBeUndefined();
  });
});

describe('invalidate', () => {
  it('varre com match `${prefixo}*` e count 100', async () => {
    await cache.invalidate('rows:planilha-1');

    expect(argDaChamada<{ match: string; count: number }>(redis.scanStream)).toEqual({
      match: 'rows:planilha-1*',
      count: 100,
    });
  });

  it('junta TODOS os lotes do stream e apaga em UMA chamada de del', async () => {
    redis.scanStream.mockReturnValue(fluxoDeLotes([['a', 'b'], ['c'], ['d', 'e']]));

    await cache.invalidate('rows:');

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith('a', 'b', 'c', 'd', 'e');
  });

  it('sem nenhuma chave encontrada, NÃO chama del', async () => {
    redis.scanStream.mockReturnValue(fluxoDeLotes([]));

    await cache.invalidate('rows:inexistente');

    expect(redis.del).not.toHaveBeenCalled();
  });

  it('lotes vazios intercalados não geram del vazio', async () => {
    redis.scanStream.mockReturnValue(fluxoDeLotes([[], [], []]));

    await cache.invalidate('rows:');

    expect(redis.del).not.toHaveBeenCalled();
  });

  it('stream que quebra no meio é engolido — sem throw e sem del parcial', async () => {
    // O `keys` acumulado até o erro é descartado junto com a exceção: o catch
    // envolve a varredura E o del, então nada é apagado.
    redis.scanStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield ['a', 'b'];
        throw new Error('Stream closed');
      },
    });

    await expect(cache.invalidate('rows:')).resolves.toBeUndefined();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('erro do del também é engolido', async () => {
    redis.scanStream.mockReturnValue(fluxoDeLotes([['a']]));
    redis.del.mockRejectedValue(new Error('CROSSSLOT Keys in request don\'t hash to the same slot'));

    await expect(cache.invalidate('rows:')).resolves.toBeUndefined();
  });
});

describe('del — assimetria proposital em relação a get/set', () => {
  it('com o Redis ainda "connecting", del AINDA tenta apagar', async () => {
    // Comportamento atual e deliberado: `del` checa só `if (!redis)`, enquanto
    // `get`/`set`/`invalidate` checam `isReady()` (status === 'ready').
    // A assimetria é conservadora: falhar ao APAGAR cache velho deixa dado
    // obsoleto circulando (pior), enquanto falhar ao LER/GRAVAR só custa um
    // hit no Google Sheets (melhor). Na dúvida, tenta apagar.
    const redisConectando = criarRedisFalso('connecting');
    cache.initCache(redisConectando);

    await cache.del('sheetApi:api-1');

    expect(redisConectando.del).toHaveBeenCalledWith('sheetApi:api-1');
  });

  it('mesma situação: get e set já desistiram, del não', async () => {
    const redisConectando = criarRedisFalso('connecting');
    cache.initCache(redisConectando);

    await cache.get('sheetApi:api-1');
    await cache.set('sheetApi:api-1', { a: 1 }, 60);
    await cache.del('sheetApi:api-1');

    expect(redisConectando.get).not.toHaveBeenCalled();
    expect(redisConectando.setex).not.toHaveBeenCalled();
    expect(redisConectando.del).toHaveBeenCalledTimes(1);
  });

  it('com redis null, del vira no-op (é a única guarda que existe)', async () => {
    cache.initCache(null);
    await expect(cache.del('qualquer')).resolves.toBeUndefined();
  });

  it('apaga exatamente uma chave por chamada', async () => {
    await cache.del('sheetApi:api-1');

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(argDaChamada<string>(redis.del)).toBe('sheetApi:api-1');
  });

  it('erro do Redis é engolido: invalidação de cache nunca derruba um PATCH', async () => {
    // `invalidateSheetApiCache` chama isto depois de gravar no Postgres. Se
    // um throw vazasse daqui, uma edição já persistida viraria 500 pro usuário.
    redis.del.mockRejectedValue(new Error('Connection is closed.'));
    await expect(cache.del('sheetApi:api-1')).resolves.toBeUndefined();
  });
});
