/**
 * Testes de caracterização de `lib/api-client.ts` — o único módulo de lógica
 * pura do `packages/web`. Todo o resto de `src/` é componente React.
 *
 * Por que este arquivo merece teste: ele é o **único ponto** por onde o
 * dashboard fala com a API, e concentra três decisões que ninguém mais revisa:
 *
 * 1. **Onde o token vive e como ele vira `Authorization`.** O token é o mesmo
 *    JWT de sessão do usuário; se o cabeçalho parar de sair, o dashboard
 *    inteiro cai em 401 e desloga o usuário sem explicação.
 * 2. **O que acontece num 401.** É o único lugar do front que apaga a sessão e
 *    manda para `/login`. Um `if` errado aqui vira laço de redirecionamento ou,
 *    pior, sessão zumbi.
 * 3. **Como o envelope de erro da API vira `Error`.** A API responde
 *    `{ code, message, request_id }`; o que sobrevive dessa viagem é o que o
 *    usuário vê na tela e o que o suporte tem para trabalhar.
 *
 * Nada é mockado no nível do próprio cliente: o `fetch`, o `localStorage` e o
 * `window` são dublês, e a asserção é sempre sobre a URL/cabeçalho/corpo que o
 * cliente REALMENTE montou, ou sobre o erro que ele REALMENTE lançou. Mockar
 * `api.fetch` provaria só que o teste sabe chamar um mock.
 *
 * Os pontos marcados com ACHADO travam o comportamento de hoje, que é
 * discutível — estão aqui para que uma mudança seja deliberada, não acidental.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Dublês
// ---------------------------------------------------------------------------

/**
 * `localStorage` de mentira, mas com estado de verdade: `setToken` seguido de
 * `getToken` tem que voltar o valor. Um `vi.fn()` puro deixaria passar um
 * cliente que grava numa chave e lê de outra.
 */
function criarArmazenamento(inicial: Record<string, string> = {}) {
  const dados = new Map<string, string>(Object.entries(inicial));
  return {
    dados,
    getItem: (chave: string) => (dados.has(chave) ? dados.get(chave)! : null),
    setItem: (chave: string, valor: string) => {
      dados.set(chave, String(valor));
    },
    removeItem: (chave: string) => {
      dados.delete(chave);
    },
  };
}

/** Resposta mínima com o que o cliente consome: `status`, `ok` e `text()`. */
function resposta(status: number, corpo = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => corpo,
  } as unknown as Response;
}

let armazenamento: ReturnType<typeof criarArmazenamento>;
let janela: { location: { href: string } };
let fetchFalso: ReturnType<typeof vi.fn>;

/**
 * `API_URL` é lido do `process.env` no topo do módulo, uma única vez. Para
 * testar a URL base é preciso recarregar o módulo depois de mexer no env — daí
 * o `resetModules` + import dinâmico.
 */
async function carregarCliente(urlBase?: string) {
  vi.resetModules();
  if (urlBase === undefined) {
    delete process.env.NEXT_PUBLIC_API_URL;
  } else {
    process.env.NEXT_PUBLIC_API_URL = urlBase;
  }
  const { api } = await import('./api-client');
  return api;
}

type Cliente = Awaited<ReturnType<typeof carregarCliente>>;

/**
 * Devolve o erro que a promessa lançou. Falha explicitamente se ela resolver —
 * um `.catch()` solto deixaria o teste passar quando o cliente PARASSE de
 * lançar, que é justamente o que se quer detectar.
 */
async function erroDe(promessa: Promise<unknown>): Promise<Error> {
  return promessa.then(
    () => {
      throw new Error('esperava que a requisição falhasse, mas ela resolveu');
    },
    (e: unknown) => e as Error
  );
}

/** Último par (url, init) entregue ao `fetch`. */
function ultimaChamada() {
  const chamada = fetchFalso.mock.calls.at(-1);
  if (!chamada) throw new Error('fetch não foi chamado');
  const [url, init] = chamada as [string, RequestInit | undefined];
  return {
    url,
    init: init ?? {},
    cabecalhos: ((init?.headers ?? {}) as Record<string, string>),
  };
}

const URL_ENV_ORIGINAL = process.env.NEXT_PUBLIC_API_URL;

beforeEach(() => {
  armazenamento = criarArmazenamento();
  janela = { location: { href: '/apis' } };
  fetchFalso = vi.fn(async () => resposta(200, '{}'));
  vi.stubGlobal('localStorage', armazenamento);
  vi.stubGlobal('window', janela);
  vi.stubGlobal('fetch', fetchFalso);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (URL_ENV_ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = URL_ENV_ORIGINAL;
});

// ---------------------------------------------------------------------------

describe('URL base', () => {
  it('cai em http://localhost:3000 quando NEXT_PUBLIC_API_URL não está definida', async () => {
    const cliente = await carregarCliente(undefined);
    await cliente.getMe();
    expect(ultimaChamada().url).toBe('http://localhost:3000/auth/me');
  });

  it('usa NEXT_PUBLIC_API_URL quando definida', async () => {
    const cliente = await carregarCliente('https://api.exemplo.com');
    await cliente.getMe();
    expect(ultimaChamada().url).toBe('https://api.exemplo.com/auth/me');
  });

  it('string vazia no env não vale como URL — volta para o localhost', async () => {
    // Contraponto do teste acima: o código usa `||`, não `??`. Um env
    // declarado-mas-vazio na Vercel silenciosamente aponta o dashboard de
    // produção para a máquina de quem abriu o navegador.
    const cliente = await carregarCliente('');
    await cliente.getMe();
    expect(ultimaChamada().url).toBe('http://localhost:3000/auth/me');
  });

  it('ACHADO: barra no fim do env vira barra dupla na URL — não há normalização', async () => {
    const cliente = await carregarCliente('https://api.exemplo.com/');
    await cliente.getMe();
    expect(ultimaChamada().url).toBe('https://api.exemplo.com//auth/me');
  });
});

describe('cabeçalho Authorization', () => {
  it('manda Bearer com o token guardado em localStorage', async () => {
    armazenamento.setItem('token', 'jwt-abc.123');
    const cliente = await carregarCliente();
    await cliente.getMe();
    expect(ultimaChamada().cabecalhos['Authorization']).toBe('Bearer jwt-abc.123');
  });

  it('sem token, não manda Authorization nenhum (nem "Bearer null")', async () => {
    const cliente = await carregarCliente();
    await cliente.getMe();
    expect(ultimaChamada().cabecalhos).not.toHaveProperty('Authorization');
  });

  it('token vazio é tratado como ausência de token', async () => {
    // Contraponto: `if (token)` e não `if (token !== null)`. Uma string vazia
    // gravada por engano não vira `Authorization: Bearer `.
    armazenamento.setItem('token', '');
    const cliente = await carregarCliente();
    await cliente.getMe();
    expect(ultimaChamada().cabecalhos).not.toHaveProperty('Authorization');
    expect(cliente.isAuthenticated()).toBe(false);
  });

  it('relê o token a cada requisição — troca de sessão vale já na chamada seguinte', async () => {
    const cliente = await carregarCliente();
    cliente.setToken('primeiro');
    await cliente.getMe();
    expect(ultimaChamada().cabecalhos['Authorization']).toBe('Bearer primeiro');

    cliente.setToken('segundo');
    await cliente.getMe();
    expect(ultimaChamada().cabecalhos['Authorization']).toBe('Bearer segundo');
  });

  it('no servidor (sem window) não lê o token, mesmo com localStorage disponível', async () => {
    // O guarda é `typeof window === "undefined"`, não a existência do
    // localStorage. Isso é o que impede o SSR de vazar/assumir sessão.
    armazenamento.setItem('token', 'jwt-do-navegador');
    vi.stubGlobal('window', undefined);
    const cliente = await carregarCliente();
    await cliente.getMe();
    expect(ultimaChamada().cabecalhos).not.toHaveProperty('Authorization');
    expect(cliente.isAuthenticated()).toBe(false);
  });

  it('preserva os cabeçalhos que quem chamou passou', async () => {
    armazenamento.setItem('token', 'jwt');
    const cliente = await carregarCliente();
    await cliente.fetch('/qualquer', { headers: { 'X-Traco': 'abc' } });
    const { cabecalhos } = ultimaChamada();
    expect(cabecalhos['X-Traco']).toBe('abc');
    expect(cabecalhos['Authorization']).toBe('Bearer jwt');
  });
});

describe('Content-Type', () => {
  it('põe application/json quando existe corpo', async () => {
    const cliente = await carregarCliente();
    await cliente.login('ana@exemplo.com', 'senha');
    expect(ultimaChamada().cabecalhos['Content-Type']).toBe('application/json');
  });

  it('não põe Content-Type em requisição sem corpo', async () => {
    const cliente = await carregarCliente();
    await cliente.listApis();
    expect(ultimaChamada().cabecalhos).not.toHaveProperty('Content-Type');
  });

  it('não põe Content-Type quando o corpo é null', async () => {
    const cliente = await carregarCliente();
    await cliente.fetch('/qualquer', { method: 'POST', body: null });
    expect(ultimaChamada().cabecalhos).not.toHaveProperty('Content-Type');
  });

  it('respeita o Content-Type que quem chamou definiu', async () => {
    const cliente = await carregarCliente();
    await cliente.fetch('/importar', {
      method: 'POST',
      body: 'a,b,c',
      headers: { 'Content-Type': 'text/csv' },
    });
    expect(ultimaChamada().cabecalhos['Content-Type']).toBe('text/csv');
  });

  it('ACHADO: a checagem é sensível a maiúsculas — "content-type" minúsculo gera cabeçalho duplicado', async () => {
    // `headers["Content-Type"] ?? "application/json"` não enxerga a chave
    // minúscula, então o objeto sai com as duas. Cabeçalho HTTP é
    // case-insensitive; o corpo `text/csv` pode acabar anunciado como JSON.
    const cliente = await carregarCliente();
    await cliente.fetch('/importar', {
      method: 'POST',
      body: 'a,b,c',
      headers: { 'content-type': 'text/csv' },
    });
    const { cabecalhos } = ultimaChamada();
    expect(cabecalhos['content-type']).toBe('text/csv');
    expect(cabecalhos['Content-Type']).toBe('application/json');
  });
});

describe('resposta 401', () => {
  it('apaga o token, manda para /login e lança Unauthorized', async () => {
    armazenamento.setItem('token', 'jwt-expirado');
    fetchFalso.mockResolvedValue(resposta(401, '{"message":"jwt expired"}'));
    const cliente = await carregarCliente();

    await expect(cliente.getMe()).rejects.toThrow('Unauthorized');
    expect(armazenamento.getItem('token')).toBeNull();
    expect(janela.location.href).toBe('/login');
  });

  it('a mensagem do envelope no 401 é descartada — sempre sai "Unauthorized"', async () => {
    fetchFalso.mockResolvedValue(
      resposta(401, '{"code":"TOKEN_EXPIRED","message":"Sua sessão expirou","request_id":"req_9"}')
    );
    const cliente = await carregarCliente();
    await expect(cliente.getMe()).rejects.toThrow('Unauthorized');
  });

  it('403 NÃO desloga nem redireciona — só o 401 mexe na sessão', async () => {
    // Contraponto do teste acima: sem isso, um `res.status >= 401` passaria.
    armazenamento.setItem('token', 'jwt-valido');
    fetchFalso.mockResolvedValue(resposta(403, '{"message":"Sem permissão"}'));
    const cliente = await carregarCliente();

    await expect(cliente.listApis()).rejects.toThrow('Sem permissão');
    expect(armazenamento.getItem('token')).toBe('jwt-valido');
    expect(janela.location.href).toBe('/apis');
  });

  it('ACHADO: 401 no servidor quebra antes de virar Unauthorized', async () => {
    // `clearToken()` mexe em `localStorage` sem o guarda de `window` que o
    // `getToken()` tem, e roda ANTES do `if (typeof window !== "undefined")`.
    // Fora do navegador o erro que chega em quem chamou é o do global ausente,
    // não o "Unauthorized" que o código pretendia lançar.
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('localStorage', undefined);
    fetchFalso.mockResolvedValue(resposta(401, ''));
    const cliente = await carregarCliente();

    await expect(cliente.getMe()).rejects.toThrow(TypeError);
    await expect(cliente.getMe()).rejects.not.toThrow('Unauthorized');
  });
});

describe('envelope de erro da API', () => {
  it('usa o campo message do envelope como mensagem do Error', async () => {
    fetchFalso.mockResolvedValue(
      resposta(400, '{"code":"VALIDATION_ERROR","message":"spreadsheetUrl inválida","request_id":"req_1"}')
    );
    const cliente = await carregarCliente();
    await expect(cliente.createApi('X', 'nao-e-url')).rejects.toThrow('spreadsheetUrl inválida');
  });

  it('ACHADO: code e request_id do envelope são jogados fora', async () => {
    // Só a `message` sobrevive. O `request_id` é o que liga a tela ao log da
    // API; hoje ele não chega em lugar nenhum do front, então o usuário não
    // tem o que informar ao suporte.
    fetchFalso.mockResolvedValue(
      resposta(422, '{"code":"QUOTA_EXCEEDED","message":"Limite atingido","request_id":"req_42"}')
    );
    const cliente = await carregarCliente();

    const erro = await erroDe(cliente.listApis());
    expect(erro).toBeInstanceOf(Error);
    expect(erro.message).toBe('Limite atingido');
    expect(JSON.stringify(erro, Object.getOwnPropertyNames(erro))).not.toContain('req_42');
    expect(erro.message).not.toContain('QUOTA_EXCEEDED');
  });

  it('sem message no corpo, cai na mensagem genérica com o status', async () => {
    fetchFalso.mockResolvedValue(resposta(500, '{"code":"INTERNAL"}'));
    const cliente = await carregarCliente();
    await expect(cliente.listApis()).rejects.toThrow('Request failed (500)');
  });

  it('corpo vazio em erro também cai na mensagem genérica', async () => {
    fetchFalso.mockResolvedValue(resposta(503, ''));
    const cliente = await carregarCliente();
    await expect(cliente.listApis()).rejects.toThrow('Request failed (503)');
  });

  it('ACHADO: resposta de erro que não é JSON vira SyntaxError e some com o status', async () => {
    // Página HTML de gateway (502/504 da Vercel, do Render ou de um proxy) é o
    // caso real. O `JSON.parse` roda ANTES do `if (!res.ok)`, então o usuário vê
    // "Unexpected token '<'" em vez de "Request failed (502)".
    fetchFalso.mockResolvedValue(resposta(502, '<html><body>Bad Gateway</body></html>'));
    const cliente = await carregarCliente();

    const erro = await erroDe(cliente.listApis());
    expect(erro).toBeInstanceOf(SyntaxError);
    expect(erro.message).not.toContain('502');
  });
});

describe('resposta de sucesso', () => {
  it('devolve o JSON já convertido', async () => {
    fetchFalso.mockResolvedValue(resposta(200, '{"apis":[{"id":"api_1"}]}'));
    const cliente = await carregarCliente();
    await expect(cliente.listApis()).resolves.toEqual({ apis: [{ id: 'api_1' }] });
  });

  it('corpo vazio (204) vira null, não quebra', async () => {
    fetchFalso.mockResolvedValue(resposta(204, ''));
    const cliente = await carregarCliente();
    await expect(cliente.deleteApi('api_1')).resolves.toBeNull();
  });
});

describe('token: guardar, limpar e consultar', () => {
  it('grava exatamente na chave "token" — é a chave que a página de callback usa', async () => {
    const cliente = await carregarCliente();
    cliente.setToken('jwt-novo');
    expect(armazenamento.getItem('token')).toBe('jwt-novo');
    expect(cliente.isAuthenticated()).toBe(true);
  });

  it('clearToken remove a chave em vez de gravar vazio', async () => {
    const cliente = await carregarCliente();
    cliente.setToken('jwt');
    cliente.clearToken();
    expect(armazenamento.dados.has('token')).toBe(false);
    expect(cliente.isAuthenticated()).toBe(false);
  });

  it('não encosta em nenhuma outra chave do localStorage', async () => {
    // O mesmo storage guarda "theme" e "sheets-banco-onboarded".
    armazenamento.setItem('theme', 'light');
    armazenamento.setItem('sheets-banco-onboarded', 'true');
    const cliente = await carregarCliente();
    cliente.setToken('jwt');
    cliente.clearToken();
    expect(armazenamento.getItem('theme')).toBe('light');
    expect(armazenamento.getItem('sheets-banco-onboarded')).toBe('true');
  });
});

describe('montagem de query string', () => {
  it('getUsage usa 7 dias por padrão', async () => {
    const cliente = await carregarCliente('http://api');
    await cliente.getUsage('api_1');
    expect(ultimaChamada().url).toBe('http://api/dashboard/apis/api_1/usage?days=7');
  });

  it('getUsage respeita o número de dias informado', async () => {
    const cliente = await carregarCliente('http://api');
    await cliente.getUsage('api_1', 30);
    expect(ultimaChamada().url).toBe('http://api/dashboard/apis/api_1/usage?days=30');
  });

  it('getUsageChart usa o mesmo padrão de 7 dias', async () => {
    const cliente = await carregarCliente('http://api');
    await cliente.getUsageChart('api_1');
    expect(ultimaChamada().url).toBe('http://api/dashboard/apis/api_1/usage/chart?days=7');
  });

  it('createSnapshot sem aba não põe query string', async () => {
    const cliente = await carregarCliente('http://api');
    await cliente.createSnapshot('api_1');
    expect(ultimaChamada().url).toBe('http://api/dashboard/apis/api_1/snapshots');
  });

  it('createSnapshot escapa o nome da aba (acento e espaço)', async () => {
    const cliente = await carregarCliente('http://api');
    await cliente.createSnapshot('api_1', 'Página 1');
    expect(ultimaChamada().url).toBe(
      'http://api/dashboard/apis/api_1/snapshots?sheet=P%C3%A1gina%201'
    );
  });

  it('createSnapshot escapa "&" — nome de aba não injeta parâmetro', async () => {
    // Contraponto: sem o `encodeURIComponent`, "A&sheet=B" viraria dois
    // parâmetros e a API leria o segundo.
    const cliente = await carregarCliente('http://api');
    await cliente.createSnapshot('api_1', 'A&sheet=B');
    expect(ultimaChamada().url).toBe(
      'http://api/dashboard/apis/api_1/snapshots?sheet=A%26sheet%3DB'
    );
  });

  it('ACHADO: parâmetro de caminho NÃO é escapado', async () => {
    // Só o `sheet` passa por `encodeURIComponent`. Os ids vão crus no template
    // literal. Hoje todos são cuid gerado pela API, então não há entrada de
    // usuário nesse caminho — mas a assimetria é fácil de esquecer se algum dia
    // um identificador passar a vir de campo de texto.
    const cliente = await carregarCliente('http://api');
    await cliente.getApi('../auth/me');
    expect(ultimaChamada().url).toBe('http://api/dashboard/apis/../auth/me');
  });
});

describe('zero à esquerda e strings sensíveis a formatação', () => {
  it('id numérico com zero à esquerda chega intacto na URL', async () => {
    // Este projeto já perdeu zero à esquerda em outra camada. Aqui o valor é
    // interpolado como string e não passa por Number() — travando isso.
    const cliente = await carregarCliente('http://api');
    await cliente.getApi('007');
    expect(ultimaChamada().url).toBe('http://api/dashboard/apis/007');
  });

  it('versão de snapshot 0 vira "/0" e não some da URL', async () => {
    // Contraponto contra um `version || ''` futuro: zero é valor legítimo.
    const cliente = await carregarCliente('http://api');
    await cliente.getSnapshot('api_1', 0);
    expect(ultimaChamada().url).toBe('http://api/dashboard/apis/api_1/snapshots/0');
  });

  it('valores com zero à esquerda sobrevivem ao JSON.stringify do corpo', async () => {
    const cliente = await carregarCliente();
    await cliente.updateApi('api_1', { codigo: '00123', cpf: '01234567890' });
    expect(JSON.parse(ultimaChamada().init.body as string)).toEqual({
      codigo: '00123',
      cpf: '01234567890',
    });
  });

  it('getUsage com days não-numérico chega cru na query (sem validação)', async () => {
    // ACHADO: a assinatura promete `number`, mas nada valida em runtime. Em JS
    // puro (a página é compilada, o consumidor pode não ser) o valor vai direto.
    const cliente = await carregarCliente('http://api');
    await cliente.getUsage('api_1', '7; drop' as unknown as number);
    expect(ultimaChamada().url).toBe('http://api/dashboard/apis/api_1/usage?days=7; drop');
  });
});

describe('corpo das requisições', () => {
  it('register sem nome omite a chave "name" do JSON', async () => {
    // `JSON.stringify({ name: undefined })` some com a chave. É o
    // comportamento que a API espera (campo opcional), e não `"name":null`.
    const cliente = await carregarCliente();
    await cliente.register('ana@exemplo.com', 'senha123');
    const corpo = JSON.parse(ultimaChamada().init.body as string);
    expect(corpo).toEqual({ email: 'ana@exemplo.com', password: 'senha123' });
    expect('name' in corpo).toBe(false);
  });

  it('register com nome inclui a chave', async () => {
    const cliente = await carregarCliente();
    await cliente.register('ana@exemplo.com', 'senha123', 'Ana');
    expect(JSON.parse(ultimaChamada().init.body as string)).toEqual({
      email: 'ana@exemplo.com',
      password: 'senha123',
      name: 'Ana',
    });
  });

  it('createApiKey sem opções manda "{}" e não corpo indefinido', async () => {
    // `opts ?? {}`: a API valida o corpo, e `undefined` viraria requisição sem
    // Content-Type nenhum (o `if` de corpo não dispararia).
    const cliente = await carregarCliente();
    await cliente.createApiKey('api_1');
    const { init, cabecalhos } = ultimaChamada();
    expect(init.body).toBe('{}');
    expect(cabecalhos['Content-Type']).toBe('application/json');
  });

  it('createApiKey repassa label, escopos e validade', async () => {
    const cliente = await carregarCliente();
    await cliente.createApiKey('api_1', {
      label: 'Apps Script FRV',
      scopes: ['read'],
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    expect(JSON.parse(ultimaChamada().init.body as string)).toEqual({
      label: 'Apps Script FRV',
      scopes: ['read'],
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
  });

  it('updateSyncSettings manda syncEnabled false sem transformar em omissão', async () => {
    // Contraponto: desligar o sync é justamente o caso em que um `if (valor)`
    // apagaria o campo e o PATCH viraria no-op.
    const cliente = await carregarCliente();
    await cliente.updateSyncSettings('api_1', { syncEnabled: false, syncCron: null });
    expect(JSON.parse(ultimaChamada().init.body as string)).toEqual({
      syncEnabled: false,
      syncCron: null,
    });
  });
});

describe('cada método bate no verbo e no caminho certos', () => {
  const casos: Array<{
    nome: string;
    executar: (c: Cliente) => Promise<unknown>;
    metodo?: string;
    caminho: string;
    corpo?: unknown;
  }> = [
    {
      nome: 'register',
      executar: (c) => c.register('a@b.com', 's', 'Ana'),
      metodo: 'POST',
      caminho: '/auth/register',
      corpo: { email: 'a@b.com', password: 's', name: 'Ana' },
    },
    {
      nome: 'login',
      executar: (c) => c.login('a@b.com', 's'),
      metodo: 'POST',
      caminho: '/auth/login',
      corpo: { email: 'a@b.com', password: 's' },
    },
    { nome: 'getMe', executar: (c) => c.getMe(), caminho: '/auth/me' },
    { nome: 'listApis', executar: (c) => c.listApis(), caminho: '/dashboard/apis' },
    {
      nome: 'createApi',
      executar: (c) => c.createApi('Agenda', 'https://docs.google.com/x'),
      metodo: 'POST',
      caminho: '/dashboard/apis',
      corpo: { name: 'Agenda', spreadsheetUrl: 'https://docs.google.com/x' },
    },
    { nome: 'getApi', executar: (c) => c.getApi('api_1'), caminho: '/dashboard/apis/api_1' },
    {
      nome: 'updateApi',
      executar: (c) => c.updateApi('api_1', { authEnabled: true }),
      metodo: 'PATCH',
      caminho: '/dashboard/apis/api_1',
      corpo: { authEnabled: true },
    },
    {
      nome: 'deleteApi',
      executar: (c) => c.deleteApi('api_1'),
      metodo: 'DELETE',
      caminho: '/dashboard/apis/api_1',
    },
    {
      nome: 'deleteApiKey',
      executar: (c) => c.deleteApiKey('api_1', 'key_9'),
      metodo: 'DELETE',
      caminho: '/dashboard/apis/api_1/keys/key_9',
    },
    {
      nome: 'listComputedFields',
      executar: (c) => c.listComputedFields('api_1'),
      caminho: '/dashboard/apis/api_1/computed-fields',
    },
    {
      nome: 'createComputedField',
      executar: (c) => c.createComputedField('api_1', 'total', '{{preco}} * {{qtd}}'),
      metodo: 'POST',
      caminho: '/dashboard/apis/api_1/computed-fields',
      corpo: { name: 'total', expression: '{{preco}} * {{qtd}}' },
    },
    {
      nome: 'updateComputedField',
      executar: (c) => c.updateComputedField('api_1', 'cf_1', '{{a}} + {{b}}'),
      metodo: 'PATCH',
      caminho: '/dashboard/apis/api_1/computed-fields/cf_1',
      corpo: { expression: '{{a}} + {{b}}' },
    },
    {
      nome: 'deleteComputedField',
      executar: (c) => c.deleteComputedField('api_1', 'cf_1'),
      metodo: 'DELETE',
      caminho: '/dashboard/apis/api_1/computed-fields/cf_1',
    },
    {
      nome: 'listSnapshots',
      executar: (c) => c.listSnapshots('api_1'),
      caminho: '/dashboard/apis/api_1/snapshots',
    },
    {
      nome: 'createSnapshot',
      executar: (c) => c.createSnapshot('api_1'),
      metodo: 'POST',
      caminho: '/dashboard/apis/api_1/snapshots',
    },
    {
      nome: 'getSnapshot',
      executar: (c) => c.getSnapshot('api_1', 3),
      caminho: '/dashboard/apis/api_1/snapshots/3',
    },
    {
      nome: 'deleteSnapshot',
      executar: (c) => c.deleteSnapshot('api_1', 3),
      metodo: 'DELETE',
      caminho: '/dashboard/apis/api_1/snapshots/3',
    },
    {
      nome: 'getSyncSettings',
      executar: (c) => c.getSyncSettings('api_1'),
      caminho: '/dashboard/apis/api_1/sync',
    },
    {
      nome: 'updateSyncSettings',
      executar: (c) => c.updateSyncSettings('api_1', { syncEnabled: true, syncCron: '0 * * * *' }),
      metodo: 'PATCH',
      caminho: '/dashboard/apis/api_1/sync',
      corpo: { syncEnabled: true, syncCron: '0 * * * *' },
    },
    {
      nome: 'triggerSync',
      executar: (c) => c.triggerSync('api_1'),
      metodo: 'POST',
      caminho: '/dashboard/apis/api_1/sync/trigger',
    },
    {
      nome: 'listSpreadsheets',
      executar: (c) => c.listSpreadsheets('api_1'),
      caminho: '/dashboard/apis/api_1/spreadsheets',
    },
    {
      nome: 'addSpreadsheet',
      executar: (c) => c.addSpreadsheet('api_1', 'https://docs.google.com/y', 'Banco'),
      metodo: 'POST',
      caminho: '/dashboard/apis/api_1/spreadsheets',
      corpo: { spreadsheetUrl: 'https://docs.google.com/y', label: 'Banco' },
    },
    {
      nome: 'removeSpreadsheet',
      executar: (c) => c.removeSpreadsheet('api_1', 'sh_2'),
      metodo: 'DELETE',
      caminho: '/dashboard/apis/api_1/spreadsheets/sh_2',
    },
  ];

  it.each(casos)('$nome', async ({ executar, metodo, caminho, corpo }) => {
    const cliente = await carregarCliente('http://api');
    await executar(cliente);
    const { url, init } = ultimaChamada();

    expect(url).toBe(`http://api${caminho}`);
    // Sem `method`, o fetch usa GET. O cliente não escreve "GET" explicitamente.
    expect(init.method).toBe(metodo);
    if (corpo === undefined) {
      expect(init.body).toBeUndefined();
    } else {
      expect(JSON.parse(init.body as string)).toEqual(corpo);
    }
  });

  it('a lista de casos cobre todos os métodos públicos do cliente', async () => {
    // Trava contra teste que envelhece: método novo no cliente sem caso aqui
    // derruba esta asserção. Os métodos que têm bloco próprio ficam de fora da
    // tabela de propósito.
    const cliente = await carregarCliente();
    const metodosDoCliente = Object.getOwnPropertyNames(
      Object.getPrototypeOf(cliente)
    ).filter((m) => m !== 'constructor');

    // Guarda contra asserção vazia: se a introspecção parar de enxergar o
    // protótipo, `semCobertura` viraria `[]` por acidente e o teste passaria
    // sem provar nada.
    expect(metodosDoCliente.length).toBeGreaterThanOrEqual(casos.length);

    const cobertosNaTabela = new Set(casos.map((c) => c.nome));
    const cobertosEmBlocoProprio = new Set([
      'fetch',
      'setToken',
      'clearToken',
      'isAuthenticated',
      'getToken',
      'createApiKey',
      'getUsage',
      'getUsageChart',
    ]);

    const semCobertura = metodosDoCliente.filter(
      (m) => !cobertosNaTabela.has(m) && !cobertosEmBlocoProprio.has(m)
    );
    expect(semCobertura).toEqual([]);
  });
});
