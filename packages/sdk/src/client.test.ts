/**
 * Testes de `SheetsBanco` — a classe que os OUTROS projetos instalam via
 * `npm i @sheets-banco/sdk`.
 *
 * Por que este arquivo é o de maior valor da leva: o SDK é a única parte deste
 * monorepo que roda **na casa dos outros**. Um erro de montagem de URL aqui não
 * derruba o build do sheets.banco — derruba a integração de quem consome, longe
 * de quem pode consertar, e sem stack trace útil. Até hoje o pacote tinha zero
 * testes.
 *
 * Estratégia: o `fetch` global é substituído por um espião que devolve
 * `Response` **de verdade** (a implementação do Node), não um objeto de mentira.
 * Isso importa: o teste de "resposta que não é JSON" só prova alguma coisa se
 * quem estoura for o `JSON.parse` real do `res.json()`. Nada de mockar método do
 * próprio cliente — o que se verifica é a URL, o header e o corpo que saíram.
 *
 * Os testes marcados com ACHADO travam o comportamento atual, não o desejado.
 * Cada um explica o que o consumidor recebe hoje.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SheetsBanco, SheetsBancoError, NetworkError, InvalidResponseError } from './index.js';

// ---------------------------------------------------------------------------
// Instrumentação do fetch
// ---------------------------------------------------------------------------

type ChamadaFetch = { url: string; init: RequestInit };

let chamadas: ChamadaFetch[] = [];

/** Instala um `fetch` falso. A fábrica é chamada a cada requisição, porque o
 *  corpo de um `Response` só pode ser lido uma vez. */
function stubFetch(fabrica: () => Response | Promise<Response>) {
  const espiao = vi.fn(async (url: unknown, init: RequestInit = {}) => {
    chamadas.push({ url: String(url), init });
    return fabrica();
  });
  vi.stubGlobal('fetch', espiao);
  return espiao;
}

/** Resposta JSON com status configurável. */
function stubJson(corpo: unknown, status = 200) {
  return stubFetch(
    () =>
      new Response(JSON.stringify(corpo), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

/** Resposta que NÃO é JSON — um HTML de proxy, por exemplo. */
function stubTexto(texto: string, status: number, contentType = 'text/html') {
  return stubFetch(
    () => new Response(texto, { status, headers: { 'Content-Type': contentType } }),
  );
}

/** `fetch` que rejeita, como faz o Node quando o DNS falha ou a conexão cai. */
function stubFalhaDeRede(mensagem: string) {
  const espiao = vi.fn(async (url: unknown, init: RequestInit = {}) => {
    chamadas.push({ url: String(url), init });
    throw new TypeError(mensagem);
  });
  vi.stubGlobal('fetch', espiao);
  return espiao;
}

const ultimaUrl = () => chamadas.at(-1)!.url;
const ultimoInit = () => chamadas.at(-1)!.init;
const ultimosHeaders = () => ultimoInit().headers as Record<string, string>;
/** Query da última URL, já decodificada. */
const ultimaQuery = () => new URL(ultimaUrl()).searchParams;

/** Cliente padrão dos testes. */
function cliente(config: Partial<ConstructorParameters<typeof SheetsBanco>[0]> = {}) {
  return new SheetsBanco({ apiId: 'api123', baseUrl: 'https://api.exemplo.com', ...config });
}

beforeEach(() => {
  chamadas = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

describe('montagem da URL base', () => {
  it('usa http://localhost:3000 quando baseUrl não é informada', async () => {
    stubJson([]);
    await new SheetsBanco({ apiId: 'api123' }).read();
    expect(ultimaUrl()).toBe('http://localhost:3000/api/v1/api123');
  });

  it('remove a barra final da baseUrl para não gerar // no caminho', async () => {
    stubJson([]);
    await cliente({ baseUrl: 'https://api.exemplo.com/' }).read();
    expect(ultimaUrl()).toBe('https://api.exemplo.com/api/v1/api123');
  });

  it('ACHADO: remove só UMA barra final — "com//" ainda produz caminho com //', async () => {
    // `replace(/\/$/, '')` tira um caractere, não todos. Não quebra a
    // requisição (o Fastify normaliza `//api/v1/...`), mas polui log e cache.
    // Fica travado para que uma eventual troca por `/\/+$/` seja uma decisão
    // consciente e não um efeito colateral.
    stubJson([]);
    await cliente({ baseUrl: 'https://api.exemplo.com//' }).read();
    expect(ultimaUrl()).toBe('https://api.exemplo.com//api/v1/api123');
  });

  it('preserva prefixo de caminho na baseUrl (API atrás de gateway)', async () => {
    stubJson([]);
    await cliente({ baseUrl: 'https://gw.exemplo.com/sheets' }).read();
    expect(ultimaUrl()).toBe('https://gw.exemplo.com/sheets/api/v1/api123');
  });

  it('ACHADO: o apiId NÃO passa por encodeURIComponent', async () => {
    // Diferente de `column`/`value`, que são escapados. Na prática o apiId é um
    // cuid gerado pelo servidor (só [a-z0-9]), então não morde hoje — mas quem
    // interpolar um valor vindo de fora no apiId injeta caminho e querystring.
    stubJson([]);
    await cliente({ apiId: 'ab/../outra?x=1' }).read();
    expect(ultimaUrl()).toBe('https://api.exemplo.com/api/v1/ab/../outra?x=1');
  });
});

describe('caminho de cada rota', () => {
  it.each([
    ['read', (c: SheetsBanco) => c.read(), '/api/v1/api123'],
    ['search', (c: SheetsBanco) => c.search({}), '/api/v1/api123/search'],
    ['searchOr', (c: SheetsBanco) => c.searchOr({}), '/api/v1/api123/search_or'],
    ['keys', (c: SheetsBanco) => c.keys(), '/api/v1/api123/keys'],
    ['count', (c: SheetsBanco) => c.count(), '/api/v1/api123/count'],
  ])('%s bate em %s', async (_nome, chamar, caminho) => {
    stubJson([]);
    await chamar(cliente());
    expect(new URL(ultimaUrl()).pathname).toBe(caminho);
  });

  it('update e delete usam /:apiId/:column/:value', async () => {
    stubJson({ updated: 1 });
    await cliente().update('cpf', '12345678900', { nome: 'Ana' });
    expect(new URL(ultimaUrl()).pathname).toBe('/api/v1/api123/cpf/12345678900');

    stubJson({ deleted: 1 });
    await cliente().delete('cpf', '12345678900');
    expect(new URL(ultimaUrl()).pathname).toBe('/api/v1/api123/cpf/12345678900');
  });

  it('escapa column e value — barra e cerquilha não vazam para o caminho', async () => {
    // Sem o escape, `Nome/Sobrenome` viraria dois segmentos (rota inexistente,
    // 404) e o `#` truncaria a URL no fragmento, apagando o resto silenciosamente.
    stubJson({ deleted: 0 });
    await cliente().delete('Nome/Sobrenome', 'Ana #1 & Cia');
    expect(ultimaUrl()).toBe(
      'https://api.exemplo.com/api/v1/api123/Nome%2FSobrenome/Ana%20%231%20%26%20Cia',
    );
  });

  it('escapa acento em column e value', async () => {
    stubJson({ updated: 0 });
    await cliente().update('Município', 'São Paulo', { uf: 'SP' });
    expect(new URL(ultimaUrl()).pathname).toBe(
      '/api/v1/api123/Munic%C3%ADpio/S%C3%A3o%20Paulo',
    );
  });
});

// ---------------------------------------------------------------------------
// Querystring
// ---------------------------------------------------------------------------

describe('montagem da querystring', () => {
  it('sem opção nenhuma, a URL sai sem "?"', async () => {
    stubJson([]);
    await cliente().read();
    expect(ultimaUrl()).not.toContain('?');
  });

  it('opção undefined é descartada e não vira "undefined" na URL', async () => {
    stubJson([]);
    await cliente().read({ sheet: undefined, limit: undefined });
    expect(ultimaUrl()).not.toContain('?');
  });

  it('serializa as opções de leitura', async () => {
    stubJson([]);
    await cliente().read({ limit: 10, offset: 20, sort_by: 'nome', sort_order: 'desc' });
    const q = ultimaQuery();
    expect(q.get('limit')).toBe('10');
    expect(q.get('offset')).toBe('20');
    expect(q.get('sort_by')).toBe('nome');
    expect(q.get('sort_order')).toBe('desc');
  });

  it('manda sheet — sem ele a API devolve só a primeira aba', async () => {
    // Armadilha conhecida do ecossistema: `GET /:apiId` sem `?sheet=` responde
    // apenas a primeira aba da planilha, e quem esqueceu acha que a API "perdeu
    // dados".
    stubJson([]);
    await cliente().read({ sheet: 'Gerência A' });
    expect(ultimaQuery().get('sheet')).toBe('Gerência A');
  });

  it('booleano true vira "true"', async () => {
    stubJson([]);
    await cliente().read({ cast_numbers: true });
    expect(ultimaQuery().get('cast_numbers')).toBe('true');
  });

  it('ACHADO: booleano false é DESCARTADO, não vira "false"', async () => {
    // O filtro é `v !== undefined && v !== false`. Consequência: não há como
    // desligar explicitamente uma opção que o servidor ligue por padrão — o
    // parâmetro simplesmente não é enviado.
    stubJson([]);
    await cliente().read({ cast_numbers: false, single_object: false });
    expect(ultimaUrl()).not.toContain('?');
  });

  it('o número 0 sobrevive (a comparação com false é estrita)', async () => {
    // Contraponto do teste acima: se o filtro fosse `if (!v)`, `limit: 0` cairia
    // junto com o `false`. Não cai.
    stubJson([]);
    await cliente().read({ limit: 0, offset: 0 });
    expect(ultimaQuery().get('limit')).toBe('0');
    expect(ultimaQuery().get('offset')).toBe('0');
  });

  it('escapa & e = no valor do filtro para não inventar parâmetro novo', async () => {
    stubJson([]);
    await cliente().search({ obs: 'a&admin=1' });
    // O valor inteiro fica em `obs`; nenhum parâmetro `admin` é criado.
    expect(ultimaQuery().get('obs')).toBe('a&admin=1');
    expect(ultimaQuery().get('admin')).toBeNull();
    expect(ultimaUrl()).toContain('obs=a%26admin%3D1');
  });

  it('espaço vira "+" no fio (forma aceita pelo parser de query)', async () => {
    stubJson([]);
    await cliente().search({ nome: 'Ana Maria' });
    expect(ultimaUrl()).toContain('nome=Ana+Maria');
    expect(ultimaQuery().get('nome')).toBe('Ana Maria');
  });

  it('escapa acento e cerquilha no valor do filtro', async () => {
    stubJson([]);
    await cliente().search({ cidade: 'São Paulo', tag: '#1' });
    expect(ultimaUrl()).toContain('cidade=S%C3%A3o+Paulo');
    expect(ultimaUrl()).toContain('tag=%231');
    expect(ultimaQuery().get('tag')).toBe('#1');
  });

  it('escapa o NOME do filtro, não só o valor', async () => {
    stubJson([]);
    await cliente().search({ 'Data de Início': '01/02/2026' });
    expect(ultimaQuery().get('Data de Início')).toBe('01/02/2026');
  });

  it('search junta filtros e opções na mesma query', async () => {
    stubJson([]);
    await cliente().search({ uf: 'CE' }, { limit: 5, casesensitive: true });
    const q = ultimaQuery();
    expect(q.get('uf')).toBe('CE');
    expect(q.get('limit')).toBe('5');
    expect(q.get('casesensitive')).toBe('true');
  });

  it('ACHADO: opção vence filtro de mesmo nome (coluna chamada "limit" é engolida)', async () => {
    // `{ ...filters, ...options }` — a opção sobrescreve. Uma planilha com
    // coluna `limit`, `offset`, `sheet` ou `sort_by` não é filtrável por ela.
    stubJson([]);
    await cliente().search({ limit: 'coluna-da-planilha' }, { limit: 5 });
    expect(ultimaQuery().get('limit')).toBe('5');
  });

  it('keys e count sem argumento não mandam query; com aba, mandam sheet', async () => {
    stubJson([]);
    await cliente().keys();
    expect(ultimaUrl()).not.toContain('?');

    stubJson([]);
    await cliente().keys('Aba 2');
    expect(ultimaQuery().get('sheet')).toBe('Aba 2');

    stubJson({ rows: 0 });
    await cliente().count('Aba 2');
    expect(ultimaQuery().get('sheet')).toBe('Aba 2');
  });

  it('keys("") é tratado como "sem aba" e não manda sheet vazio', async () => {
    stubJson([]);
    await cliente().keys('');
    expect(ultimaUrl()).not.toContain('?');
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe('headers de autenticação e conteúdo', () => {
  it('sempre manda Content-Type: application/json', async () => {
    stubJson([]);
    await cliente().read();
    expect(ultimosHeaders()['Content-Type']).toBe('application/json');
  });

  it('manda Authorization: Bearer quando há bearerToken', async () => {
    stubJson([]);
    await cliente({ bearerToken: 'tok-secreto' }).read();
    expect(ultimosHeaders()['Authorization']).toBe('Bearer tok-secreto');
  });

  it('não manda Authorization quando não há token', async () => {
    stubJson([]);
    await cliente().read();
    expect(ultimosHeaders()['Authorization']).toBeUndefined();
  });

  it('o header vai em TODOS os métodos, não só no GET', async () => {
    const c = cliente({ bearerToken: 'tok-secreto' });

    stubJson({ created: 1 }, 201);
    await c.create({ a: '1' });
    expect(ultimosHeaders()['Authorization']).toBe('Bearer tok-secreto');

    stubJson({ updated: 1 });
    await c.update('a', '1', { b: '2' });
    expect(ultimosHeaders()['Authorization']).toBe('Bearer tok-secreto');

    stubJson({ deleted: 1 });
    await c.delete('a', '1');
    expect(ultimosHeaders()['Authorization']).toBe('Bearer tok-secreto');
  });

  it('ACHADO: o cliente só sabe montar Bearer — nem X-API-Key, nem Basic', async () => {
    // A API aceita três formas (Bearer, Basic e chave de API em `X-API-Key`).
    // O SDK expõe apenas `bearerToken`. Quem tem chave de API precisa passá-la
    // como `bearerToken` — funciona, porque a API aceita chave no
    // `Authorization: Bearer`, mas o nome do campo esconde isso do consumidor.
    // Quem tem usuário/senha (Basic) não tem caminho no SDK.
    stubJson([]);
    await cliente({ bearerToken: 'chave-de-api' }).read();
    const h = ultimosHeaders();
    expect(h['X-API-Key']).toBeUndefined();
    expect(h['Authorization']).toBe('Bearer chave-de-api');
    expect(Object.keys(h).sort()).toEqual(['Authorization', 'Content-Type']);
  });

  it('token vazio não vira "Bearer " sem valor', async () => {
    stubJson([]);
    await cliente({ bearerToken: '' }).read();
    expect(ultimosHeaders()['Authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Corpo e método
// ---------------------------------------------------------------------------

describe('método HTTP e serialização do corpo', () => {
  it('leitura não manda corpo nem método explícito', async () => {
    stubJson([]);
    await cliente().read();
    expect(ultimoInit().body).toBeUndefined();
    expect(ultimoInit().method).toBeUndefined();
  });

  it('create envelopa a linha em {"data": ...} e usa POST', async () => {
    stubJson({ created: 1 }, 201);
    await cliente().create({ nome: 'Ana', uf: 'CE' });
    expect(ultimoInit().method).toBe('POST');
    expect(JSON.parse(ultimoInit().body as string)).toEqual({
      data: { nome: 'Ana', uf: 'CE' },
    });
  });

  it('create aceita array e o envelope preserva o array', async () => {
    stubJson({ created: 2 }, 201);
    await cliente().create([{ nome: 'Ana' }, { nome: 'Bia' }]);
    expect(JSON.parse(ultimoInit().body as string)).toEqual({
      data: [{ nome: 'Ana' }, { nome: 'Bia' }],
    });
  });

  it('update usa PATCH e envelopa em {"data": ...}', async () => {
    stubJson({ updated: 1 });
    await cliente().update('cpf', '123', { nome: 'Ana' });
    expect(ultimoInit().method).toBe('PATCH');
    expect(JSON.parse(ultimoInit().body as string)).toEqual({ data: { nome: 'Ana' } });
  });

  it('delete usa DELETE e não manda corpo', async () => {
    stubJson({ deleted: 1 });
    await cliente().delete('cpf', '123');
    expect(ultimoInit().method).toBe('DELETE');
    expect(ultimoInit().body).toBeUndefined();
  });

  it('caractere fora do ASCII no corpo sobrevive à serialização', async () => {
    stubJson({ created: 1 }, 201);
    await cliente().create({ nome: 'José 🌎', obs: 'aspas " e barra \\' });
    expect(JSON.parse(ultimoInit().body as string)).toEqual({
      data: { nome: 'José 🌎', obs: 'aspas " e barra \\' },
    });
  });
});

// ---------------------------------------------------------------------------
// Normalização da resposta de leitura
// ---------------------------------------------------------------------------

describe('normalização da resposta de leitura', () => {
  it('array volta como array', async () => {
    stubJson([{ a: '1' }, { a: '2' }]);
    await expect(cliente().read()).resolves.toEqual([{ a: '1' }, { a: '2' }]);
  });

  it('objeto único (single_object) é embrulhado em array', async () => {
    // A API responde um objeto quando `single_object=true`; o SDK promete
    // `SheetRow[]` em `read`, então embrulha.
    stubJson({ a: '1' });
    await expect(cliente().read({ single_object: true })).resolves.toEqual([{ a: '1' }]);
  });

  it('lista vazia continua vazia, não vira [ [] ]', async () => {
    stubJson([]);
    await expect(cliente().read()).resolves.toEqual([]);
  });

  it('search e searchOr aplicam a mesma normalização', async () => {
    stubJson({ a: '1' });
    await expect(cliente().search({ a: '1' })).resolves.toEqual([{ a: '1' }]);

    stubJson({ a: '1' });
    await expect(cliente().searchOr({ a: '1' })).resolves.toEqual([{ a: '1' }]);
  });

  it('keys devolve o array de cabeçalhos como veio', async () => {
    stubJson(['nome', 'cpf', 'uf']);
    await expect(cliente().keys()).resolves.toEqual(['nome', 'cpf', 'uf']);
  });

  it('count devolve {rows}', async () => {
    stubJson({ rows: 42 });
    await expect(cliente().count()).resolves.toEqual({ rows: 42 });
  });
});

// ---------------------------------------------------------------------------
// Tradução do erro da API
// ---------------------------------------------------------------------------

/** Envelope de erro que a API realmente emite (ver `lib/error-handler.ts`). */
const ENVELOPE_404 = {
  error: true,
  message: 'API not found',
  code: 'API_NOT_FOUND',
  statusCode: 404,
  request_id: 'req_abc123',
};

/** Captura o erro sem depender de `rejects`, para poder inspecionar campos. */
async function capturar(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('esperava que a promessa rejeitasse, mas resolveu');
}

describe('tradução da resposta de erro da API', () => {
  it('resposta 4xx vira SheetsBancoError com status, code e message da API', async () => {
    stubJson(ENVELOPE_404, 404);
    const erro = await capturar(() => cliente().read());
    expect(erro).toBeInstanceOf(SheetsBancoError);
    expect(erro.name).toBe('SheetsBancoError');
    expect(erro.status).toBe(404);
    expect(erro.code).toBe('API_NOT_FOUND');
    expect(erro.message).toBe('API not found');
  });

  it('o request_id do envelope chega ao consumidor', async () => {
    // É o que `docs/error-handling.md` promete e o que liga o relato de quem
    // usa o SDK à linha de log do servidor. Antes o construtor recebia só
    // (status, code, message) e o campo era descartado: o chamado abria sem o
    // id e do outro lado não havia como achar a requisição.
    stubJson(ENVELOPE_404, 404);
    const erro = await capturar(() => cliente().read());

    expect(erro.requestId).toBe('req_abc123');
    // E o corpo cru fica disponível para o que o tipo não cobre.
    expect(erro.body).toEqual(ENVELOPE_404);
  });

  it('ACHADO: o header X-Request-Id também não é aproveitado', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify(ENVELOPE_404), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req_do_header' },
        }),
    );
    const erro = await capturar(() => cliente().read());
    expect(JSON.stringify(erro)).not.toContain('req_do_header');
  });

  it('cai para UNKNOWN_ERROR quando a resposta de erro não traz code', async () => {
    stubJson({ message: 'algo quebrou' }, 500);
    const erro = await capturar(() => cliente().read());
    expect(erro.code).toBe('UNKNOWN_ERROR');
    expect(erro.message).toBe('algo quebrou');
    expect(erro.status).toBe(500);
  });

  it('monta mensagem a partir do status quando a resposta não traz message', async () => {
    stubJson({ code: 'RATE_LIMIT_EXCEEDED' }, 429);
    const erro = await capturar(() => cliente().read());
    expect(erro.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(erro.message).toBe('Request failed with status 429');
  });

  it('401 de API protegida chega com o código da API intacto', async () => {
    // Depois do rollout do Bearer, 401 é o erro mais provável de um consumidor
    // mal configurado. O `code` é o que diz se falta credencial ou se ela é inválida.
    stubJson(
      { error: true, message: 'Unauthorized', code: 'UNAUTHORIZED', statusCode: 401, request_id: 'req_x' },
      401,
    );
    const erro = await capturar(() => cliente({ bearerToken: 'errado' }).read());
    expect(erro.status).toBe(401);
    expect(erro.code).toBe('UNAUTHORIZED');
  });

  it('erro em qualquer método vira SheetsBancoError, não só no read', async () => {
    const c = cliente();
    stubJson({ code: 'CREATE_DISABLED', message: 'Creating rows is disabled' }, 403);
    await expect(c.create({ a: '1' })).rejects.toBeInstanceOf(SheetsBancoError);

    stubJson({ code: 'UPDATE_DISABLED', message: 'x' }, 403);
    await expect(c.update('a', '1', { b: '2' })).rejects.toBeInstanceOf(SheetsBancoError);

    stubJson({ code: 'DELETE_DISABLED', message: 'x' }, 403);
    await expect(c.delete('a', '1')).rejects.toBeInstanceOf(SheetsBancoError);

    stubJson({ code: 'API_NOT_FOUND', message: 'x' }, 404);
    await expect(c.keys()).rejects.toBeInstanceOf(SheetsBancoError);

    stubJson({ code: 'API_NOT_FOUND', message: 'x' }, 404);
    await expect(c.count()).rejects.toBeInstanceOf(SheetsBancoError);

    stubJson({ code: 'API_NOT_FOUND', message: 'x' }, 404);
    await expect(c.searchOr({ a: '1' })).rejects.toBeInstanceOf(SheetsBancoError);
  });

  it('204 sem corpo resolve com null em vez de estourar no parse', async () => {
    // Antes o `res.json()` era chamado antes de qualquer checagem, inclusive em
    // resposta sem corpo, e um DELETE bem-sucedido rejeitava com SyntaxError.
    stubFetch(() => new Response(null, { status: 204 }));
    await expect(cliente().delete('a', '1')).resolves.toBeNull();
  });
});

describe('resposta que não é JSON vira erro útil, não SyntaxError cru', () => {
  // Antes, `const data = await res.json()` rodava ANTES do `if (!res.ok)` e
  // fora do try/catch. Qualquer resposta não-JSON — HTML de proxy, página de
  // manutenção do Render, 502 do gateway, corpo cortado — saía do SDK como
  // `SyntaxError` do `JSON.parse`. Quem escreveu
  // `catch (e) { if (e instanceof SheetsBancoError) ... }` não pegava o caso, e
  // a mensagem ("Unexpected token '<'") não dizia nem o status nem o que
  // chegou.

  it('HTML de proxy em 502 vira InvalidResponseError com o status e um trecho', async () => {
    stubTexto('<html><body>502 Bad Gateway</body></html>', 502);
    const erro = await capturar(() => cliente().read());

    expect(erro).toBeInstanceOf(InvalidResponseError);
    // E continua sendo SheetsBancoError: um catch só cobre tudo.
    expect(erro).toBeInstanceOf(SheetsBancoError);
    expect(erro.status).toBe(502);
    expect(erro.code).toBe('INVALID_RESPONSE');
    expect(erro.message).toContain('502');
    expect(erro.message).toContain('502 Bad Gateway');
  });

  it('HTML de página de login em 200 também vira erro tratável', async () => {
    stubTexto('<!doctype html><title>Entrar</title>', 200);
    const erro = await capturar(() => cliente().read());

    expect(erro).toBeInstanceOf(InvalidResponseError);
    expect(erro.status).toBe(200);
  });

  it('corpo JSON truncado no meio idem, com o trecho no corpo do erro', async () => {
    stubTexto('[{"a":"1"},{"a"', 200, 'application/json');
    const erro = await capturar(() => cliente().read());

    expect(erro).toBeInstanceOf(InvalidResponseError);
    expect(erro.body).toBe('[{"a":"1"},{"a"');
  });

  it('trecho longo é truncado com reticências para não poluir o log', async () => {
    stubTexto('<html>' + 'x'.repeat(500) + '</html>', 502);
    const erro = await capturar(() => cliente().read());

    expect(erro.message.length).toBeLessThan(200);
    expect(erro.message).toContain('…');
  });

  it('corpo vazio com status 500 vira SheetsBancoError, não erro de parse', async () => {
    // Corpo vazio não é JSON inválido — é ausência de corpo. O status é que
    // manda, e o consumidor recebe o erro de servidor que esperava.
    stubTexto('', 500, 'application/json');
    const erro = await capturar(() => cliente().read());

    expect(erro).toBeInstanceOf(SheetsBancoError);
    expect(erro).not.toBeInstanceOf(InvalidResponseError);
    expect(erro.status).toBe(500);
    expect(erro.code).toBe('UNKNOWN_ERROR');
  });
});

describe('falha de rede', () => {
  it('fetch que rejeita vira NetworkError com a mensagem original', async () => {
    stubFalhaDeRede('fetch failed');
    const erro = await capturar(() => cliente().read());
    expect(erro).toBeInstanceOf(NetworkError);
    expect(erro.name).toBe('NetworkError');
    expect(erro.message).toBe('fetch failed');
  });

  it('NetworkError também é SheetsBancoError, com status 0 e code NETWORK_ERROR', async () => {
    // Importa para o consumidor: um único `catch (e) { if (e instanceof
    // SheetsBancoError) }` cobre erro de API e queda de rede, e o `status === 0`
    // é o que distingue os dois.
    stubFalhaDeRede('getaddrinfo ENOTFOUND api.exemplo.com');
    const erro = await capturar(() => cliente().read());
    expect(erro).toBeInstanceOf(SheetsBancoError);
    expect(erro.status).toBe(0);
    expect(erro.code).toBe('NETWORK_ERROR');
  });

  it('rejeição que não é Error vira mensagem genérica em vez de "undefined"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'string solta';
      }),
    );
    const erro = await capturar(() => cliente().read());
    expect(erro).toBeInstanceOf(NetworkError);
    expect(erro.message).toBe('Network request failed');
  });

  it('erro de rede em escrita também vira NetworkError (não fica pendurado)', async () => {
    stubFalhaDeRede('socket hang up');
    await expect(cliente().create({ a: '1' })).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// O que o cliente NÃO faz
// ---------------------------------------------------------------------------

describe('ausência de retry e de timeout', () => {
  it('não tenta de novo em 500 — uma requisição, uma chamada de fetch', async () => {
    const espiao = stubJson({ code: 'INTERNAL_ERROR', message: 'x' }, 500);
    await capturar(() => cliente().read());
    expect(espiao).toHaveBeenCalledTimes(1);
  });

  it('não tenta de novo em 429 nem respeita Retry-After', async () => {
    const espiao = stubFetch(
      () =>
        new Response(JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', message: 'x' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
        }),
    );
    await capturar(() => cliente().read());
    expect(espiao).toHaveBeenCalledTimes(1);
  });

  it('não tenta de novo quando a rede cai', async () => {
    const espiao = stubFalhaDeRede('fetch failed');
    await capturar(() => cliente().read());
    expect(espiao).toHaveBeenCalledTimes(1);
  });

  it('ACHADO: nenhum AbortSignal é passado — requisição pendurada trava para sempre', async () => {
    // Sem `signal`/`AbortController`, uma resposta que nunca chega deixa a
    // promessa pendente até o timeout do socket do Node. Um job que lê planilha
    // grande fica preso sem sinal nenhum.
    stubJson([]);
    await cliente().read();
    expect(ultimoInit().signal).toBeUndefined();
  });
});

describe('escrita: assíncrona por padrão, síncrona sob demanda', () => {
  // A rota de escrita da API só executa na hora quando recebe `?sync=true`.
  // Sem isso ela ENFILEIRA (BullMQ) e responde **202** com
  // `{ queued: true, jobId }` — ver `packages/api/src/routes/v1/sheets.ts`.
  //
  // O SDK declarava `Promise<{ created: number }>` e nunca pedia o modo
  // síncrono. `res.created` era `undefined` em runtime enquanto o TypeScript
  // afirmava que era `number`: um `if (res.created > 0)` compilava e era
  // sempre falso. Hoje o retorno é união discriminada e o modo é escolha de
  // quem chama.

  it('create sem opção não manda sync e devolve o corpo enfileirado', async () => {
    stubJson({ queued: true, jobId: 'job_1' }, 202);
    const res = await cliente().create({ a: '1' });

    expect(ultimaUrl()).not.toContain('sync');
    expect(res).toEqual({ queued: true, jobId: 'job_1' });
  });

  it('create com { sync: true } manda sync=true e devolve a contagem', async () => {
    stubJson({ created: 2 }, 201);
    const res = await cliente().create([{ a: '1' }, { a: '2' }], { sync: true });

    expect(ultimaUrl()).toContain('sync=true');
    expect(res).toEqual({ created: 2 });
  });

  it('update e delete seguem a mesma regra', async () => {
    stubJson({ queued: true, matchedRows: 3 }, 202);
    await cliente().update('a', '1', { b: '2' });
    expect(ultimaUrl()).not.toContain('sync');

    stubJson({ updated: 3 });
    await cliente().update('a', '1', { b: '2' }, { sync: true });
    expect(ultimaUrl()).toContain('sync=true');

    stubJson({ queued: true, matchedRows: 1 }, 202);
    await cliente().delete('a', '1');
    expect(ultimaUrl()).not.toContain('sync');

    stubJson({ deleted: 1 });
    await cliente().delete('a', '1', { sync: true });
    expect(ultimaUrl()).toContain('sync=true');
  });

  it('`queued in res` estreita a união nos dois sentidos', async () => {
    // É o teste que prova que o tipo serve para alguma coisa: sem a união
    // discriminada, o consumidor não teria como saber qual formato chegou.
    stubJson({ queued: true, jobId: 'job_9' }, 202);
    const enfileirado = await cliente().create({ a: '1' });

    if ('queued' in enfileirado) {
      expect(enfileirado.jobId).toBe('job_9');
    } else {
      throw new Error('esperava resposta enfileirada');
    }

    stubJson({ created: 1 }, 201);
    const sincrono = await cliente().create({ a: '1' }, { sync: true });

    if ('queued' in sincrono) {
      throw new Error('esperava resposta síncrona');
    } else {
      expect(sincrono.created).toBe(1);
    }
  });

  it('{ sync: false } é igual a não pedir nada', async () => {
    stubJson({ queued: true }, 202);
    await cliente().create({ a: '1' }, { sync: false });
    expect(ultimaUrl()).not.toContain('sync=true');
  });
});

describe('estado do cliente entre chamadas', () => {
  it('duas instâncias com apiId diferente não se contaminam', async () => {
    stubJson([]);
    const a = cliente({ apiId: 'aaa' });
    const b = cliente({ apiId: 'bbb', bearerToken: 'tok-b' });

    await a.read();
    expect(ultimaUrl()).toContain('/api/v1/aaa');
    expect(ultimosHeaders()['Authorization']).toBeUndefined();

    await b.read();
    expect(ultimaUrl()).toContain('/api/v1/bbb');
    expect(ultimosHeaders()['Authorization']).toBe('Bearer tok-b');
  });

  it('a mesma instância serve várias chamadas seguidas', async () => {
    const espiao = stubJson([]);
    const c = cliente();
    await c.read();
    await c.read({ limit: 1 });
    await c.keys();
    expect(espiao).toHaveBeenCalledTimes(3);
    expect(chamadas.map((ch) => new URL(ch.url).pathname)).toEqual([
      '/api/v1/api123',
      '/api/v1/api123',
      '/api/v1/api123/keys',
    ]);
  });
});
