/**
 * Testes de caracterização de `middleware/cors.ts`.
 *
 * Por que este arquivo merece teste: é controle de acesso por origem, roda como
 * hook `onRequest` em TODAS as rotas de `/api/v1` (ver `routes/v1/sheets.ts` e
 * `routes/v1/import-export.ts`) e estava com 0% de cobertura. Um refactor que
 * trocasse `Access-Control-Allow-Origin: <origem>` por `*` abriria toda API
 * restrita para qualquer site, e nenhum teste reclamaria.
 *
 * O middleware é exercitado dentro de um Fastify de verdade (`montarApp` +
 * `app.inject()`) porque o que se quer travar são os HEADERS DE RESPOSTA — e
 * `reply.header()` só produz header observável quando o Fastify serializa a
 * resposta. Um mock de `reply` provaria apenas que a função foi chamada.
 *
 * A decisão de design que os testes documentam: **servidor permissivo,
 * navegador restritivo**. Numa requisição normal (GET/POST) de origem não
 * permitida a resposta sai completa, com dados e tudo — só sem o header
 * `Access-Control-Allow-Origin`. Quem bloqueia a leitura é o navegador. CORS
 * aqui não é autenticação; quem precisa de bloqueio real usa Bearer/chave.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SheetApi } from '../services/sheet-api-cache.service.js';
import { montarApp } from '../test-utils/app.js';
import { apiCors } from './cors.js';

/**
 * SheetApi completa. Só `corsOrigins` importa para este middleware; o resto é
 * preenchimento para satisfazer o tipo sem `as any`.
 */
function criarSheetApi(over: Partial<SheetApi> = {}): SheetApi {
  return {
    id: 'api-1',
    name: 'Minha API',
    spreadsheetId: 'planilha-abc',
    slug: 'minha-api',
    userId: 'user-1',
    allowRead: true,
    allowCreate: true,
    allowUpdate: true,
    allowDelete: true,
    bearerToken: null,
    bearerTokenHash: null,
    bearerTokenPrevious: null,
    bearerTokenPreviousHash: null,
    bearerTokenRotatedAt: null,
    basicUser: null,
    basicPass: null,
    basicPassHash: null,
    authEnabled: true,
    hmacSecret: null,
    requireSigning: false,
    corsOrigins: null,
    ipWhitelist: null,
    rateLimitRpm: 60,
    cacheTtlSeconds: 60,
    syncEnabled: false,
    syncCron: null,
    autoSnapshotOnWrite: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

/** O que o hook anterior (resolver da SheetApi) teria injetado na requisição. */
let sheetApiDaRequisicao: SheetApi | undefined;

/** Espião do handler: prova se a requisição chegou (ou não) na rota. */
const handlerExecutado = vi.fn();

async function rotas(app: FastifyInstance) {
  // Espelha a ordem de produção: o resolver injeta `request.sheetApi` num
  // onRequest anterior e o apiCors só lê o que já está lá.
  app.addHook('onRequest', async (request) => {
    request.sheetApi = sheetApiDaRequisicao;
  });
  app.addHook('onRequest', apiCors);

  app.route({
    method: ['GET', 'POST', 'OPTIONS'],
    url: '/api-1/rows',
    handler: async () => {
      handlerExecutado();
      return { rows: [] };
    },
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  sheetApiDaRequisicao = criarSheetApi();
  app = await montarApp({ rotas, prefixo: '/api/v1' });
});

const URL_ROTA = '/api/v1/api-1/rows';

describe('sem SheetApi resolvida', () => {
  it('não toca em header nenhum e deixa a requisição passar', async () => {
    // Cenário real: rota que não passou pelo resolver, ou resolver que não
    // achou a API. O middleware sai na primeira linha.
    sheetApiDaRequisicao = undefined;

    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://qualquer.com' },
    });

    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['access-control-allow-methods']).toBeUndefined();
    expect(r.headers['access-control-allow-headers']).toBeUndefined();
    expect(r.headers['access-control-max-age']).toBeUndefined();
    expect(r.headers['vary']).toBeUndefined();
    expect(handlerExecutado).toHaveBeenCalledTimes(1);
  });

  it('nem o preflight OPTIONS é interceptado — cai no handler da rota', async () => {
    // Consequência do `return` antecipado: sem sheetApi não há 204 de
    // preflight. O OPTIONS vira uma requisição comum e executa o handler.
    sheetApiDaRequisicao = undefined;

    const r = await app.inject({
      method: 'OPTIONS',
      url: URL_ROTA,
      headers: { origin: 'https://qualquer.com' },
    });

    expect(r.statusCode).toBe(200);
    expect(handlerExecutado).toHaveBeenCalledTimes(1);
  });
});

describe('corsOrigins nulo — API sem restrição de origem', () => {
  it('devolve Access-Control-Allow-Origin: *', async () => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: null });

    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://site-aleatorio.com' },
    });

    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
  });

  it('NÃO emite Vary: Origin no modo curinga (assimetria proposital)', async () => {
    // Com `*` a resposta é idêntica para toda origem, então não há o que
    // variar. O `Vary` só aparece no modo lista, onde o header muda por
    // requisição.
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: null });

    const r = await app.inject({ method: 'GET', url: URL_ROTA, headers: { origin: 'https://a.com' } });

    expect(r.headers['vary']).toBeUndefined();
  });

  it('responde * mesmo sem header Origin (requisição servidor-a-servidor)', async () => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: null });

    const r = await app.inject({ method: 'GET', url: URL_ROTA });

    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
  });

  it('corsOrigins VAZIO ("") também vira * — string vazia é falsy', async () => {
    // Armadilha operacional: limpar o campo no dashboard pensando em "não
    // permitir nenhuma origem" faz o oposto — libera todas. Só `null` e `""`
    // caem no mesmo ramo curinga.
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: '' });

    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://invasor.com' },
    });

    expect(r.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('corsOrigins com lista — origem permitida', () => {
  beforeEach(() => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com,https://b.com' });
  });

  it('devolve a origem EXATA, nunca *', async () => {
    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://a.com' },
    });

    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('https://a.com');
    expect(r.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('emite Vary: Origin para não envenenar cache compartilhado', async () => {
    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://b.com' },
    });

    expect(r.headers['vary']).toBe('Origin');
  });

  it('aparara espaços da lista — "https://a.com, https://b.com" aceita a segunda', async () => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com, https://b.com' });

    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://b.com' },
    });

    expect(r.headers['access-control-allow-origin']).toBe('https://b.com');
    expect(r.headers['vary']).toBe('Origin');
  });

  it('o corpo da rota continua sendo entregue normalmente', async () => {
    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://a.com' },
    });

    expect(r.json()).toEqual({ rows: [] });
    expect(handlerExecutado).toHaveBeenCalledTimes(1);
  });
});

describe('corsOrigins com lista — origem NÃO permitida', () => {
  beforeEach(() => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com,https://b.com' });
  });

  it('GET não recebe Access-Control-Allow-Origin, mas a requisição NÃO é bloqueada', async () => {
    // Decisão atual, travada de propósito: servidor permissivo + navegador
    // restritivo. O servidor processa e responde 200 com os dados; a ausência
    // do header faz o navegador recusar a leitura no fetch/XHR. Um cliente que
    // não seja navegador (curl, Apps Script, backend) recebe tudo. CORS aqui
    // NÃO é autorização — para bloquear de verdade existem apiAuth e a IP
    // whitelist.
    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://invasor.com' },
    });

    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.json()).toEqual({ rows: [] });
    expect(handlerExecutado).toHaveBeenCalledTimes(1);
  });

  it('POST de origem não permitida também passa — a escrita acontece', async () => {
    // O mesmo raciocínio vale para método que muta dados. É o ponto mais
    // afiado da decisão acima e merece estar explícito.
    const r = await app.inject({
      method: 'POST',
      url: URL_ROTA,
      headers: { origin: 'https://invasor.com' },
      payload: { nome: 'Ana' },
    });

    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(handlerExecutado).toHaveBeenCalledTimes(1);
  });

  it('não emite Vary: Origin quando recusa a origem', async () => {
    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://invasor.com' },
    });

    expect(r.headers['vary']).toBeUndefined();
  });

  it('a comparação é exata: subdomínio de origem permitida não é aceito', async () => {
    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://evil.a.com' },
    });

    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a comparação é exata: só muda o esquema (http vs https) e já não vale', async () => {
    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'http://a.com' },
    });

    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a comparação é sensível a maiúsculas — https://A.com não casa com https://a.com', async () => {
    // Origin é case-insensitive no host pela RFC, mas aqui o match é string
    // literal. Na prática o navegador normaliza para minúsculas, então isso
    // atinge cliente não-navegador.
    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://A.com' },
    });

    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requisição SEM header Origin cai no ramo "não permitida"', async () => {
    // `request.headers.origin ?? ''` transforma ausência em string vazia, que
    // não está na lista. Para GET é inofensivo (só não sai o header), mas o
    // teste do OPTIONS abaixo mostra a consequência dura.
    const r = await app.inject({ method: 'GET', url: URL_ROTA });

    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('preflight OPTIONS', () => {
  it('origem não permitida vira 403 CORS_FORBIDDEN', async () => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com' });

    const r = await app.inject({
      method: 'OPTIONS',
      url: URL_ROTA,
      headers: { origin: 'https://invasor.com' },
    });

    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({
      error: true,
      message: 'Origin not allowed.',
      code: 'CORS_FORBIDDEN',
      statusCode: 403,
    });
    expect(handlerExecutado).not.toHaveBeenCalled();
  });

  it('o 403 sai SEM os headers fixos de CORS — o `return` acontece antes deles', async () => {
    // Caracterização de um detalhe de ordem: as linhas que setam
    // Allow-Methods/Allow-Headers/Max-Age vêm depois do `return reply.status(403)`,
    // então a resposta de recusa não os carrega.
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com' });

    const r = await app.inject({
      method: 'OPTIONS',
      url: URL_ROTA,
      headers: { origin: 'https://invasor.com' },
    });

    expect(r.headers['access-control-allow-methods']).toBeUndefined();
    expect(r.headers['access-control-allow-headers']).toBeUndefined();
    expect(r.headers['access-control-max-age']).toBeUndefined();
  });

  it('OPTIONS sem header Origin também leva 403 numa API com lista', async () => {
    // Efeito colateral do `?? ''`: um cliente não-navegador que faça OPTIONS
    // para descobrir métodos suportados recebe 403, mesmo sem ser CORS.
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com' });

    const r = await app.inject({ method: 'OPTIONS', url: URL_ROTA });

    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('CORS_FORBIDDEN');
  });

  it('origem permitida devolve 204 sem corpo e não chega no handler', async () => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com' });

    const r = await app.inject({
      method: 'OPTIONS',
      url: URL_ROTA,
      headers: { origin: 'https://a.com' },
    });

    expect(r.statusCode).toBe(204);
    expect(r.payload).toBe('');
    expect(handlerExecutado).not.toHaveBeenCalled();
  });

  it('o 204 do preflight carrega origem exata, Vary e os headers fixos', async () => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com' });

    const r = await app.inject({
      method: 'OPTIONS',
      url: URL_ROTA,
      headers: { origin: 'https://a.com' },
    });

    expect(r.headers['access-control-allow-origin']).toBe('https://a.com');
    expect(r.headers['vary']).toBe('Origin');
    expect(r.headers['access-control-max-age']).toBe('86400');
  });

  it('API sem restrição responde 204 com * para qualquer preflight', async () => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: null });

    const r = await app.inject({
      method: 'OPTIONS',
      url: URL_ROTA,
      headers: { origin: 'https://qualquer.com' },
    });

    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(handlerExecutado).not.toHaveBeenCalled();
  });
});

describe('headers fixos', () => {
  const cenarios: Array<[string, string | null, string | undefined]> = [
    ['API sem restrição', null, 'https://qualquer.com'],
    ['origem permitida', 'https://a.com', 'https://a.com'],
    ['origem recusada em GET', 'https://a.com', 'https://invasor.com'],
    ['sem header Origin', null, undefined],
  ];

  it.each(cenarios)(
    '%s — Allow-Methods, Allow-Headers e Max-Age saem na resposta',
    async (_nome, corsOrigins, origin) => {
      sheetApiDaRequisicao = criarSheetApi({ corsOrigins });

      const r = await app.inject({
        method: 'GET',
        url: URL_ROTA,
        ...(origin ? { headers: { origin } } : {}),
      });

      expect(r.headers['access-control-allow-methods']).toBe(
        'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      );
      expect(r.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
      expect(r.headers['access-control-max-age']).toBe('86400');
    },
  );

  it('Allow-Headers não inclui X-API-Key nem as de assinatura HMAC', async () => {
    // Divergência real de contrato: a API aceita `X-API-Key` (PR #118) e
    // `X-Signature`/`X-Signature-Version` (hmac-verify), mas o preflight não
    // os declara. Um navegador que mande esses headers cross-origin tem o
    // preflight recusado pelo próprio navegador. Consumidores server-side
    // (Apps Script, backend) não passam por preflight e não sentem.
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: null });

    const r = await app.inject({ method: 'GET', url: URL_ROTA });
    const permitidos = r.headers['access-control-allow-headers'];

    expect(permitidos).not.toContain('X-API-Key');
    expect(permitidos).not.toContain('X-Signature');
  });
});

describe('vírgula sobrando na lista não abre buraco', () => {
  // Antes, `'https://a.com,'.split(',')` virava `['https://a.com', '']`, e
  // como origem ausente chega aqui como `''` (por causa do `?? ''`), a
  // requisição sem header `Origin` passava a "estar na lista". O middleware
  // devolvia `Access-Control-Allow-Origin:` com valor vazio e o preflight sem
  // Origin dava 204 em vez de 403. Um caractere a mais digitado no dashboard
  // mudava o comportamento.
  //
  // O `filter(Boolean)` tira a entrada vazia e o `origin &&` garante que
  // origem ausente nunca case, mesmo que um vazio entre na lista por outro
  // caminho.

  it('requisição SEM Origin não recebe header de origem permitida', async () => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com,' });

    const r = await app.inject({ method: 'GET', url: URL_ROTA });

    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['vary']).toBeUndefined();
  });

  it('OPTIONS sem Origin continua dando 403 mesmo com a vírgula sobrando', async () => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com,' });

    const r = await app.inject({ method: 'OPTIONS', url: URL_ROTA });

    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('CORS_FORBIDDEN');
  });

  it('a origem que ESTÁ na lista continua sendo aceita', async () => {
    // O contraponto: a correção não podia quebrar a lista de verdade.
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: 'https://a.com,' });

    const r = await app.inject({
      method: 'GET',
      url: URL_ROTA,
      headers: { origin: 'https://a.com' },
    });

    expect(r.headers['access-control-allow-origin']).toBe('https://a.com');
    expect(r.headers['vary']).toBe('Origin');
  });

  it('lista com vários vazios (",,https://b.com,,") ainda funciona', async () => {
    sheetApiDaRequisicao = criarSheetApi({ corsOrigins: ',,https://b.com,,' });

    const permitida = await app.inject({
      method: 'GET', url: URL_ROTA, headers: { origin: 'https://b.com' },
    });
    const semOrigin = await app.inject({ method: 'GET', url: URL_ROTA });

    expect(permitida.headers['access-control-allow-origin']).toBe('https://b.com');
    expect(semOrigin.headers['access-control-allow-origin']).toBeUndefined();
  });
});
