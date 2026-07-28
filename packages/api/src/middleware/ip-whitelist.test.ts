/**
 * Testes de caracterização de `middleware/ip-whitelist.ts`.
 *
 * Por que este arquivo merece teste: é o **único controle de rede por API**
 * desta base. Quando alguém marca "só estes IPs" numa SheetApi, é este hook —
 * 8 statements, registrado como `onRequest` em `routes/v1/sheets.ts` e
 * `routes/v1/import-export.ts` — que decide passar ou devolver 403. Estava com
 * 0% de cobertura.
 *
 * O que os testes travam, além do caminho feliz:
 * - **lista vazia libera geral** (`''` é falsy, então `!ipWhitelist` corta o
 *   middleware antes de comparar nada);
 * - a comparação é **string exata**: sem CIDR, sem faixa, sem wildcard, sem
 *   normalização de IPv6-mapeado. Quem configura precisa saber, porque
 *   `10.0.0.0/8` na lista não libera nenhuma máquina da rede 10;
 * - `request.ip` depende de `trustProxy`, que a produção liga (`index.ts`) e o
 *   `montarApp` de teste não — vide o último bloco.
 *
 * Nota: exercitamos via `app.inject({ remoteAddress })`, que é o que alimenta
 * `request.ip` no Fastify. Testar o middleware por chamada direta (como faz
 * `hmac-verify.test.ts`) não provaria que o `return reply.status(403)` de fato
 * interrompe a cadeia de hooks e impede o handler de rodar.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SheetApi } from '@prisma/client';
import { montarApp } from '../test-utils/app.js';
import { apiIpWhitelist } from './ip-whitelist.js';

/**
 * SheetApi resolvida que o hook enxerga. O middleware só lê `ipWhitelist`, mas
 * o tipo é o registro inteiro do Prisma — daí o cast, para não montar um
 * fixture de 30 colunas irrelevantes.
 */
function apiCom(ipWhitelist: string | null | undefined): SheetApi {
  return { id: 'api-1', name: 'API de teste', ipWhitelist } as unknown as SheetApi;
}

/** SheetApi que o hook de setup injeta na request; trocada por teste. */
let apiAtual: SheetApi | undefined;

/** Quantas vezes o handler final rodou — prova que o 403 corta a cadeia. */
let handlerExecutado = 0;

/**
 * Espelha o registro real em `routes/v1/sheets.ts`: um hook `onRequest` resolve
 * a SheetApi e o `apiIpWhitelist` roda logo em seguida, também em `onRequest`.
 */
async function rotasDeTeste(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    request.sheetApi = apiAtual;
  });
  app.addHook('onRequest', apiIpWhitelist);
  app.get('/:apiId', async () => {
    handlerExecutado += 1;
    return { ok: true };
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  apiAtual = undefined;
  handlerExecutado = 0;
  app = await montarApp({ rotas: rotasDeTeste, prefixo: '/api/v1' });
});

/** Atalho: bate na rota vindo de `ip`. */
function chamar(ip: string) {
  return app.inject({ method: 'GET', url: '/api/v1/api-1', remoteAddress: ip });
}

describe('apiIpWhitelist — casos que passam direto', () => {
  it('sem sheetApi resolvida, não bloqueia nada', async () => {
    // Cenário real: rota que não passou pelo hook de resolução da API.
    // O middleware não tem contra o que comparar e simplesmente sai.
    apiAtual = undefined;

    const r = await chamar('203.0.113.99');

    expect(r.statusCode).toBe(200);
    expect(handlerExecutado).toBe(1);
  });

  it('ipWhitelist null libera todos os IPs', async () => {
    apiAtual = apiCom(null);

    const r = await chamar('203.0.113.99');

    expect(r.statusCode).toBe(200);
  });

  it('ipWhitelist undefined libera todos os IPs', async () => {
    apiAtual = apiCom(undefined);

    const r = await chamar('203.0.113.99');

    expect(r.statusCode).toBe(200);
  });

  it('ATENÇÃO: ipWhitelist string vazia LIBERA GERAL, não bloqueia geral', async () => {
    // Contra-intuitivo e por isso travado aqui: `''` é falsy, então
    // `if (!sheetApi.ipWhitelist) return` corta o middleware antes de montar a
    // lista. "Lista vazia" NÃO significa "ninguém entra" — significa "todo
    // mundo entra". Se alguém apagar o conteúdo do campo pelo dashboard
    // achando que está trancando a API, está abrindo.
    apiAtual = apiCom('');

    const r = await chamar('198.51.100.7');

    expect(r.statusCode).toBe(200);
    expect(handlerExecutado).toBe(1);
  });

  it('IP presente na lista passa', async () => {
    apiAtual = apiCom('203.0.113.10,198.51.100.7');

    const r = await chamar('198.51.100.7');

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('lista de um único IP, sem vírgula, funciona', async () => {
    apiAtual = apiCom('203.0.113.10');

    expect((await chamar('203.0.113.10')).statusCode).toBe(200);
  });

  it('espaços em volta dos IPs são aparados', async () => {
    // `"1.2.3.4, 5.6.7.8"` — o espaço depois da vírgula é o formato que sai de
    // qualquer humano digitando no dashboard. O `.map(ip => ip.trim())` cobre.
    apiAtual = apiCom('1.2.3.4, 5.6.7.8');

    expect((await chamar('1.2.3.4')).statusCode).toBe(200);
    expect((await chamar('5.6.7.8')).statusCode).toBe(200);
  });

  it('espaços exagerados e quebra de linha também são aparados', async () => {
    apiAtual = apiCom('  1.2.3.4  ,\n\t5.6.7.8 ');

    expect((await chamar('1.2.3.4')).statusCode).toBe(200);
    expect((await chamar('5.6.7.8')).statusCode).toBe(200);
  });
});

describe('apiIpWhitelist — bloqueio', () => {
  it('IP fora da lista recebe 403 com code IP_FORBIDDEN', async () => {
    apiAtual = apiCom('1.2.3.4, 5.6.7.8');

    const r = await chamar('9.9.9.9');

    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({
      error: true,
      message: 'Your IP address is not allowed.',
      code: 'IP_FORBIDDEN',
      statusCode: 403,
    });
  });

  it('o 403 interrompe a cadeia — o handler da rota não roda', async () => {
    apiAtual = apiCom('1.2.3.4');

    await chamar('9.9.9.9');

    expect(handlerExecutado).toBe(0);
  });

  it('a resposta de bloqueio traz request_id e o header X-Request-Id', async () => {
    // Este middleware responde direto pelo `reply`, sem passar pelo
    // `setErrorHandler` — que é quem acrescentava o `request_id`. Eram 31
    // pontos assim, e todos saíam sem correlação de log. Agora um hook de
    // `preSerialization` completa o envelope de qualquer resposta de erro,
    // tenha ela sido lançada ou enviada direto.
    apiAtual = apiCom('1.2.3.4');

    const r = await chamar('9.9.9.9');

    expect(r.json().request_id).toBeTruthy();
    expect(r.headers['x-request-id']).toBe(r.json().request_id);
  });

  it('lista com vírgula sobrando não vira curinga', async () => {
    // `'1.2.3.4,'` produz `['1.2.3.4', '']`. A entrada vazia é inofensiva
    // porque `request.ip` nunca é string vazia — mas vale travar.
    apiAtual = apiCom('1.2.3.4,');

    expect((await chamar('1.2.3.4')).statusCode).toBe(200);
    expect((await chamar('9.9.9.9')).statusCode).toBe(403);
  });
});

describe('apiIpWhitelist — comparação é string EXATA (limitações reais)', () => {
  it('CIDR não é suportado: 10.0.0.0/8 na lista NÃO libera 10.0.0.1', async () => {
    // Limitação real, não bug de teste: o middleware faz
    // `allowed.includes(clientIp)`, comparação literal de string. Nenhuma
    // notação de bloco é interpretada. Quem escreve um CIDR no dashboard
    // acredita ter liberado a rede inteira e na prática trancou tudo — o
    // único IP que passaria seria a string "10.0.0.0/8", que não existe.
    apiAtual = apiCom('10.0.0.0/8');

    expect((await chamar('10.0.0.1')).statusCode).toBe(403);
    expect((await chamar('10.255.255.254')).statusCode).toBe(403);
    expect((await chamar('10.0.0.0')).statusCode).toBe(403);
  });

  it('faixa com hífen também não é interpretada', async () => {
    apiAtual = apiCom('10.0.0.1-10.0.0.9');

    expect((await chamar('10.0.0.5')).statusCode).toBe(403);
  });

  it('curinga * não libera nada (nem ele mesmo, na prática)', async () => {
    // Quem tenta "liberar tudo" com `*` na verdade tranca tudo. Para liberar
    // tudo o caminho é deixar o campo nulo/vazio.
    apiAtual = apiCom('*');

    expect((await chamar('1.2.3.4')).statusCode).toBe(403);
  });

  it('IPv4 mapeado em IPv6 não é normalizado: ::ffff:1.2.3.4 é bloqueado por "1.2.3.4"', async () => {
    // Armadilha de deploy: dependendo de como o socket é aceito (dual-stack),
    // o Node entrega o IP na forma mapeada. Como a comparação é textual, a
    // mesma máquina passa ou não conforme a forma que chega.
    apiAtual = apiCom('1.2.3.4');

    expect((await chamar('::ffff:1.2.3.4')).statusCode).toBe(403);
  });

  it('loopback IPv6 (::1) não equivale a 127.0.0.1', async () => {
    apiAtual = apiCom('127.0.0.1');

    expect((await chamar('::1')).statusCode).toBe(403);
    expect((await chamar('127.0.0.1')).statusCode).toBe(200);
  });

  it('a comparação diferencia maiúsculas em IPv6', async () => {
    // `2001:DB8::1` e `2001:db8::1` são o mesmo endereço para a IANA e
    // endereços diferentes para o `includes`.
    apiAtual = apiCom('2001:DB8::1');

    expect((await chamar('2001:db8::1')).statusCode).toBe(403);
    expect((await chamar('2001:DB8::1')).statusCode).toBe(200);
  });
});

describe('apiIpWhitelist — de onde vem o request.ip (trustProxy)', () => {
  /**
   * Este bloco monta o Fastify localmente em vez de usar `montarApp`, porque o
   * ponto é justamente a opção do construtor: a produção (`src/index.ts`) usa
   * `trustProxy: true` e o `montarApp` de teste não passa a opção. Sem tocar no
   * helper compartilhado, a única forma de documentar as duas leituras é
   * instanciar aqui.
   */
  async function montarComProxy(trustProxy: boolean) {
    const instancia = Fastify({ logger: false, trustProxy });
    await instancia.register(rotasDeTeste, { prefix: '/api/v1' });
    await instancia.ready();
    return instancia;
  }

  it('com trustProxy ligado (como em produção), X-Forwarded-For define o IP checado', async () => {
    apiAtual = apiCom('203.0.113.42');
    const comProxy = await montarComProxy(true);

    const r = await comProxy.inject({
      method: 'GET',
      url: '/api/v1/api-1',
      remoteAddress: '10.0.0.1', // o proxy
      headers: { 'x-forwarded-for': '203.0.113.42' }, // o cliente real
    });

    expect(r.statusCode).toBe(200);
    await comProxy.close();
  });

  it('com trustProxy desligado, o IP checado é o do socket e o header é ignorado', async () => {
    // Consequência operacional: se `trustProxy` fosse desligado no Render, a
    // whitelist passaria a comparar contra o IP do proxy — trancando todos os
    // clientes de uma vez, mesmo com a lista correta.
    apiAtual = apiCom('203.0.113.42');
    const semProxy = await montarComProxy(false);

    const r = await semProxy.inject({
      method: 'GET',
      url: '/api/v1/api-1',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.42' },
    });

    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('IP_FORBIDDEN');
    await semProxy.close();
  });

  it('com trustProxy ligado, o header falsificado por quem NÃO é proxy também é aceito', async () => {
    // Não é bug deste middleware, mas é o risco herdado de `trustProxy: true`
    // sem lista de proxies confiáveis: quem alcançar a app diretamente pode
    // escolher o próprio IP via X-Forwarded-For e furar a whitelist. Fica
    // travado aqui para que a mudança seja consciente se alguém restringir o
    // `trustProxy` no futuro.
    apiAtual = apiCom('203.0.113.42');
    const comProxy = await montarComProxy(true);

    const r = await comProxy.inject({
      method: 'GET',
      url: '/api/v1/api-1',
      remoteAddress: '9.9.9.9',
      headers: { 'x-forwarded-for': '203.0.113.42' },
    });

    expect(r.statusCode).toBe(200);
    await comProxy.close();
  });
});
