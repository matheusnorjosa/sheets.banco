/**
 * Testes de caracterização de `src/cli.ts` — o único arquivo do pacote
 * `sheets-banco-cli`, que até aqui não tinha nem script `test`.
 *
 * Por que este arquivo merece teste: ele é a porta de entrada humana da API.
 * Quem roda `sheets-banco login` está entregando e-mail e senha, e o resultado
 * é gravado em disco (`~/.sheets-banco/config.json`) como Bearer token. Um erro
 * na montagem da URL ou no header de autorização não aparece em teste de rota
 * da API — aparece como "não funciona na minha máquina".
 *
 * O desafio é que CLI mistura lógica com efeito colateral: `process.exit`,
 * `console.log`, `fs` e `fetch`. A estratégia aqui:
 *
 *  - `node:fs` e `node:os` viram um sistema de arquivos em memória, então dá
 *    para afirmar EXATAMENTE o que foi gravado e onde, sem tocar no HOME real
 *    de quem roda o teste;
 *  - `fetch` é espionado — o que se prova é a URL, o método, o corpo e os
 *    headers que o CLI monta. Não se mocka `apiFetch`: é justamente ele que
 *    precisa ser provado;
 *  - `process.exit` **lança** uma sentinela em vez de virar no-op. Isso é mais
 *    fiel: `process.exit` de verdade nunca retorna, e um no-op deixaria rodar
 *    código que em produção jamais roda (em `apiFetch`, por exemplo, o `return
 *    data` logo depois do `exit(1)`), o que produziria falha fantasma;
 *  - `commander` é estendido só para GUARDAR a promessa que `program.parse()`
 *    descarta. Nenhuma lógica do CLI é substituída — sem isso não haveria como
 *    esperar o fim de um handler `async`, e é essa mesma promessa descartada
 *    que está registrada como ACHADO no fim do arquivo.
 *
 * Os itens marcados com ACHADO travam o comportamento ATUAL, não o desejado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Sistema de arquivos em memória
// ---------------------------------------------------------------------------

const fsFalso = vi.hoisted(() => ({
  arquivos: new Map<string, string>(),
  diretorios: new Set<string>(),
  chamadasMkdir: [] as Array<{ caminho: string; opcoes: unknown }>,
}));

vi.mock('node:os', () => {
  const api = { homedir: () => '/casa-falsa' };
  return { ...api, default: api };
});

vi.mock('node:fs', () => {
  const api = {
    existsSync: (p: string) =>
      fsFalso.arquivos.has(String(p)) || fsFalso.diretorios.has(String(p)),
    readFileSync: (p: string) => {
      const conteudo = fsFalso.arquivos.get(String(p));
      if (conteudo === undefined) throw new Error(`ENOENT: ${String(p)}`);
      return conteudo;
    },
    writeFileSync: (p: string, c: string) => {
      fsFalso.arquivos.set(String(p), String(c));
    },
    mkdirSync: (p: string, opcoes: unknown) => {
      fsFalso.chamadasMkdir.push({ caminho: String(p), opcoes });
      fsFalso.diretorios.add(String(p));
    },
  };
  return { ...api, default: api };
});

// ---------------------------------------------------------------------------
// commander: só para não perder a promessa que `parse()` joga fora
// ---------------------------------------------------------------------------

const capturado = vi.hoisted(() => ({
  promessa: undefined as Promise<unknown> | undefined,
}));

vi.mock('commander', async (importOriginal) => {
  const original = await importOriginal<typeof import('commander')>();
  class ComandoQueGuardaAPromessa extends original.Command {
    override parse(argv?: readonly string[], opcoes?: unknown) {
      // `parseAsync` é o mesmo caminho de `parse`, só que devolvendo a cadeia
      // de promessas em vez de descartá-la. Ver ACHADO "parse() vs parseAsync".
      capturado.promessa = this.parseAsync(
        argv as string[] | undefined,
        opcoes as never,
      );
      return this;
    }
  }
  return { ...original, Command: ComandoQueGuardaAPromessa };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** `process.exit` real nunca retorna; a sentinela reproduz isso. */
class SaidaDoProcesso extends Error {
  constructor(readonly codigo: number | undefined) {
    super(`process.exit(${String(codigo)})`);
  }
}

const CONFIG_DIR = path.join('/casa-falsa', '.sheets-banco');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
  fsFalso.arquivos.clear();
  fsFalso.diretorios.clear();
  fsFalso.chamadasMkdir.length = 0;
  stdout = [];
  stderr = [];

  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    stdout.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
    stdout.push(String(s).replace(/\n$/, ''));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => {
    stderr.push(String(s).replace(/\n$/, ''));
    return true;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((codigo?: number) => {
    throw new SaidaDoProcesso(codigo);
  }) as never);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('fetch não foi programado neste teste'),
  );
});

interface Resultado {
  /** Código passado a `process.exit`, ou `undefined` se o comando terminou. */
  saida: number | undefined;
  stdout: string[];
  stderr: string[];
  /** stdout e stderr juntos, para asserção de texto solto. */
  texto: string;
}

/** Executa o CLI de ponta a ponta com os argumentos dados. */
async function rodar(...args: string[]): Promise<Resultado> {
  capturado.promessa = undefined;
  const argvOriginal = process.argv;
  process.argv = ['node', 'sheets-banco', ...args];
  vi.resetModules();
  let saida: number | undefined;
  try {
    await import('./cli.js');
    await capturado.promessa;
  } catch (e) {
    if (!(e instanceof SaidaDoProcesso)) throw e;
    saida = e.codigo;
  } finally {
    process.argv = argvOriginal;
  }
  return { saida, stdout, stderr, texto: [...stdout, ...stderr].join('\n') };
}

/** Resposta mínima de `fetch` — só o que o CLI consome. */
function resposta(opcoes: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  texto?: string;
}): Response {
  const { ok = true, status = 200, json, texto } = opcoes;
  return {
    ok,
    status,
    json: async () => json,
    text: async () => texto ?? JSON.stringify(json),
  } as unknown as Response;
}

function programarFetch(...respostas: Response[]): void {
  const espiao = vi.mocked(globalThis.fetch);
  espiao.mockReset();
  // Fallback explícito: se algum comando pedir mais respostas do que o teste
  // programou, o teste falha em vez de escapar para a rede de verdade.
  espiao.mockRejectedValue(new Error('fetch não foi programado neste teste'));
  for (const r of respostas) espiao.mockResolvedValueOnce(r);
}

function chamadasFetch(): Array<{
  url: string;
  init: RequestInit & { headers?: Record<string, string> };
}> {
  return vi.mocked(globalThis.fetch).mock.calls.map((c) => ({
    url: String(c[0]),
    init: (c[1] ?? {}) as RequestInit & { headers?: Record<string, string> },
  }));
}

function ultimaChamadaFetch() {
  const todas = chamadasFetch();
  const ultima = todas.at(-1);
  if (!ultima) throw new Error('fetch não foi chamado');
  return ultima;
}

function gravarConfig(config: Record<string, unknown>): void {
  fsFalso.diretorios.add(CONFIG_DIR);
  fsFalso.arquivos.set(CONFIG_FILE, JSON.stringify(config));
}

function lerConfig(): Record<string, unknown> {
  const bruto = fsFalso.arquivos.get(CONFIG_FILE);
  if (bruto === undefined) throw new Error('config.json não foi gravado');
  return JSON.parse(bruto) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('registro dos comandos', () => {
  it('sem argumento nenhum mostra a ajuda e sai com 1', async () => {
    const r = await rodar();
    expect(r.saida).toBe(1);
    // A ajuda vai para stderr — importa porque um pipe (`| grep`) não a captura.
    expect(r.stderr.join('\n')).toContain('Usage: sheets-banco');
  });

  it('a ajuda lista os seis comandos de topo', async () => {
    const r = await rodar();
    for (const comando of ['init', 'login', 'logout', 'apis', 'export', 'types']) {
      expect(r.stderr.join('\n')).toContain(comando);
    }
  });

  it('comando inexistente sai com 1 e não chama a API', async () => {
    const r = await rodar('deploy');
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toMatch(/unknown command/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('--version imprime a versão em stdout e sai com 0', async () => {
    const r = await rodar('--version');
    expect(r.saida).toBe(0);
    expect(r.stdout.join('\n')).toContain('0.1.0');
  });
});

describe('leitura da configuração em ~/.sheets-banco/config.json', () => {
  it('sem arquivo, cai no padrão http://localhost:3000', async () => {
    programarFetch(resposta({ json: { apis: [] } }));
    await rodar('apis', 'list');
    expect(ultimaChamadaFetch().url).toBe('http://localhost:3000/dashboard/apis');
  });

  it('com arquivo, usa a apiUrl gravada', async () => {
    gravarConfig({ apiUrl: 'https://sheets.exemplo.com' });
    programarFetch(resposta({ json: { apis: [] } }));
    await rodar('apis', 'list');
    expect(ultimaChamadaFetch().url).toBe(
      'https://sheets.exemplo.com/dashboard/apis',
    );
  });

  it('config.json corrompido não derruba o CLI — volta ao padrão', async () => {
    // O `catch {}` do loadConfig existe para isto: quem editou o arquivo à mão
    // e quebrou o JSON deve continuar conseguindo rodar `init` para consertar.
    fsFalso.diretorios.add(CONFIG_DIR);
    fsFalso.arquivos.set(CONFIG_FILE, '{ isto não é json');
    programarFetch(resposta({ json: { apis: [] } }));
    const r = await rodar('apis', 'list');
    expect(r.saida).toBeUndefined();
    expect(ultimaChamadaFetch().url).toBe('http://localhost:3000/dashboard/apis');
  });

  it('token gravado vira header Authorization: Bearer', async () => {
    gravarConfig({ apiUrl: 'https://x.com', token: 'tok-123' });
    programarFetch(resposta({ json: { apis: [] } }));
    await rodar('apis', 'list');
    expect(ultimaChamadaFetch().init.headers).toMatchObject({
      Authorization: 'Bearer tok-123',
      'Content-Type': 'application/json',
    });
  });

  it('sem token, o header Authorization simplesmente não existe', async () => {
    // Contraponto do teste acima: se a chave existisse com valor vazio, a API
    // responderia 401 em vez de tratar a chamada como anônima.
    programarFetch(resposta({ json: { apis: [] } }));
    await rodar('apis', 'list');
    expect(ultimaChamadaFetch().init.headers).not.toHaveProperty('Authorization');
  });
});

describe('gravação da configuração', () => {
  it('cria ~/.sheets-banco com recursive quando o diretório não existe', async () => {
    await rodar('init');
    expect(fsFalso.chamadasMkdir).toEqual([
      { caminho: CONFIG_DIR, opcoes: { recursive: true } },
    ]);
  });

  it('não recria o diretório quando ele já existe', async () => {
    gravarConfig({ apiUrl: 'https://ja-existe.com' });
    await rodar('init');
    expect(fsFalso.chamadasMkdir).toEqual([]);
  });

  it('grava JSON indentado, para continuar editável à mão', async () => {
    await rodar('init', 'https://api.exemplo.com');
    expect(fsFalso.arquivos.get(CONFIG_FILE)).toBe(
      '{\n  "apiUrl": "https://api.exemplo.com"\n}',
    );
  });
});

describe('comando init', () => {
  it('sem argumento usa o default http://localhost:3000', async () => {
    const r = await rodar('init');
    expect(lerConfig()).toEqual({ apiUrl: 'http://localhost:3000' });
    expect(r.stdout.join('\n')).toContain('http://localhost:3000');
  });

  it('grava a URL informada', async () => {
    await rodar('init', 'https://api.exemplo.com');
    expect(lerConfig()).toEqual({ apiUrl: 'https://api.exemplo.com' });
  });

  it('preserva o token já existente ao trocar de URL', async () => {
    // `init` não é `logout`: trocar de ambiente não pode derrubar a sessão.
    gravarConfig({ apiUrl: 'http://localhost:3000', token: 'tok-antigo' });
    await rodar('init', 'https://prod.exemplo.com');
    expect(lerConfig()).toEqual({
      apiUrl: 'https://prod.exemplo.com',
      token: 'tok-antigo',
    });
  });

  it('informa o caminho do arquivo de configuração', async () => {
    const r = await rodar('init');
    expect(r.stdout.join('\n')).toContain(CONFIG_FILE);
  });

  it('ACHADO: a URL não é validada — qualquer texto é aceito', async () => {
    // Não há `.argParser` nem checagem de protocolo. "ftp://" ou "banana" são
    // gravados e só quebram depois, no primeiro `fetch`, com erro genérico.
    await rodar('init', 'banana');
    expect(lerConfig()).toEqual({ apiUrl: 'banana' });
  });
});

describe('comando login', () => {
  it('exige --email', async () => {
    const r = await rodar('login', '-p', 'senha');
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toMatch(/required option.*--email/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('exige --password', async () => {
    const r = await rodar('login', '-e', 'ana@exemplo.com');
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toMatch(/required option.*--password/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('faz POST em /auth/login com e-mail e senha no corpo', async () => {
    gravarConfig({ apiUrl: 'https://api.exemplo.com' });
    programarFetch(
      resposta({ json: { token: 'tok-novo', user: { email: 'ana@exemplo.com' } } }),
    );
    await rodar('login', '-e', 'ana@exemplo.com', '-p', 's3nh4');

    const { url, init } = ultimaChamadaFetch();
    expect(url).toBe('https://api.exemplo.com/auth/login');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'ana@exemplo.com',
      password: 's3nh4',
    });
  });

  it('grava o token devolvido e confirma o e-mail logado', async () => {
    gravarConfig({ apiUrl: 'https://api.exemplo.com' });
    programarFetch(
      resposta({ json: { token: 'tok-novo', user: { email: 'ana@exemplo.com' } } }),
    );
    const r = await rodar('login', '-e', 'ana@exemplo.com', '-p', 's3nh4');

    expect(r.saida).toBeUndefined();
    expect(lerConfig()).toEqual({
      apiUrl: 'https://api.exemplo.com',
      token: 'tok-novo',
    });
    expect(r.stdout.join('\n')).toContain('Logged in as: ana@exemplo.com');
  });

  it('a senha nunca aparece na saída do terminal', async () => {
    programarFetch(
      resposta({ json: { token: 'tok', user: { email: 'ana@exemplo.com' } } }),
    );
    const r = await rodar('login', '-e', 'ana@exemplo.com', '-p', 'senha-secreta');
    expect(r.texto).not.toContain('senha-secreta');
  });

  it('com 2FA ativo, avisa, sai com 1 e NÃO grava token', async () => {
    // O contraponto é o "não grava": gravar um token pela metade deixaria o
    // CLI num estado em que todo comando seguinte devolve 401 sem explicação.
    programarFetch(resposta({ json: { requires2FA: true } }));
    const r = await rodar('login', '-e', 'ana@exemplo.com', '-p', 's3nh4');

    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toContain('2FA is enabled');
    expect(fsFalso.arquivos.has(CONFIG_FILE)).toBe(false);
  });

  it('credencial inválida imprime a mensagem da API e sai com 1', async () => {
    programarFetch(
      resposta({ ok: false, status: 401, json: { message: 'Invalid credentials' } }),
    );
    const r = await rodar('login', '-e', 'ana@exemplo.com', '-p', 'errada');

    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toContain('Error: Invalid credentials');
    expect(fsFalso.arquivos.has(CONFIG_FILE)).toBe(false);
  });

  it('erro sem campo message cai no texto genérico', async () => {
    programarFetch(resposta({ ok: false, status: 500, json: {} }));
    const r = await rodar('login', '-e', 'ana@exemplo.com', '-p', 's3nh4');
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toContain('Error: Request failed');
  });
});

describe('comando logout', () => {
  it('remove o token e preserva a apiUrl', async () => {
    gravarConfig({ apiUrl: 'https://api.exemplo.com', token: 'tok-123' });
    const r = await rodar('logout');
    expect(lerConfig()).toEqual({ apiUrl: 'https://api.exemplo.com' });
    expect(r.stdout.join('\n')).toContain('Logged out.');
  });

  it('sem sessão aberta, ainda assim termina com sucesso', async () => {
    const r = await rodar('logout');
    expect(r.saida).toBeUndefined();
    // ACHADO: `logout` sem sessão CRIA o config.json com o padrão. Inofensivo,
    // mas é escrita em disco onde não havia nada para apagar.
    expect(lerConfig()).toEqual({ apiUrl: 'http://localhost:3000' });
  });

  it('não chama a API — o logout é só local', async () => {
    // Fica registrado: o token continua válido no servidor depois do logout.
    gravarConfig({ apiUrl: 'https://api.exemplo.com', token: 'tok-123' });
    await rodar('logout');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('apis list', () => {
  it('lista vazia sugere o comando de criação', async () => {
    programarFetch(resposta({ json: { apis: [] } }));
    const r = await rodar('apis', 'list');
    expect(r.stdout.join('\n')).toContain('No APIs found.');
    expect(r.stdout.join('\n')).toContain('sheets-banco apis create');
  });

  it('usa GET (sem method explícito) em /dashboard/apis', async () => {
    programarFetch(resposta({ json: { apis: [] } }));
    await rodar('apis', 'list');
    const { url, init } = ultimaChamadaFetch();
    expect(url).toBe('http://localhost:3000/dashboard/apis');
    expect(init.method).toBeUndefined();
  });

  it('imprime nome, id, slug e contadores de cada API', async () => {
    programarFetch(
      resposta({
        json: {
          apis: [
            {
              id: 'api_1',
              name: 'Agenda 2026',
              slug: 'agenda-2026',
              _count: { usageLogs: 42, apiKeys: 3 },
            },
          ],
        },
      }),
    );
    const r = await rodar('apis', 'list');
    const texto = r.stdout.join('\n');
    expect(texto).toContain('Agenda 2026');
    expect(texto).toContain('ID:   api_1');
    expect(texto).toContain('Slug: agenda-2026');
    expect(texto).toContain('Requests: 42  Keys: 3');
  });

  it('sem slug, a linha Slug some (não vira "undefined")', async () => {
    programarFetch(
      resposta({ json: { apis: [{ id: 'api_1', name: 'Sem slug', slug: null }] } }),
    );
    const r = await rodar('apis', 'list');
    expect(r.stdout.join('\n')).not.toContain('Slug:');
  });

  it('sem _count, os contadores caem para 0 em vez de undefined', async () => {
    programarFetch(
      resposta({ json: { apis: [{ id: 'api_1', name: 'Nova' }] } }),
    );
    const r = await rodar('apis', 'list');
    expect(r.stdout.join('\n')).toContain('Requests: 0  Keys: 0');
  });

  it('erro da API sai com 1 antes de imprimir qualquer API', async () => {
    programarFetch(
      resposta({ ok: false, status: 403, json: { message: 'Forbidden' } }),
    );
    const r = await rodar('apis', 'list');
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toContain('Error: Forbidden');
    expect(r.stdout.join('\n')).not.toContain('Your APIs');
  });
});

describe('apis create', () => {
  const urlPlanilha =
    'https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0';

  it('exige --name', async () => {
    const r = await rodar('apis', 'create', urlPlanilha);
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toMatch(/required option.*--name/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('exige a URL da planilha como argumento', async () => {
    const r = await rodar('apis', 'create', '-n', 'Minha API');
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toMatch(/missing required argument/i);
  });

  it('traduz argumento+opções para o corpo { name, spreadsheetUrl }', async () => {
    programarFetch(
      resposta({ json: { api: { id: 'api_9', name: 'Minha API', slug: null } } }),
    );
    await rodar('apis', 'create', urlPlanilha, '-n', 'Minha API');

    const { url, init } = ultimaChamadaFetch();
    expect(url).toBe('http://localhost:3000/dashboard/apis');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Minha API',
      spreadsheetUrl: urlPlanilha,
    });
  });

  it('só manda slug quando --slug foi informado', async () => {
    programarFetch(
      resposta({ json: { api: { id: 'api_9', name: 'X', slug: 'meu-slug' } } }),
    );
    await rodar('apis', 'create', urlPlanilha, '-n', 'X', '-s', 'meu-slug');
    expect(JSON.parse(String(ultimaChamadaFetch().init.body))).toEqual({
      name: 'X',
      spreadsheetUrl: urlPlanilha,
      slug: 'meu-slug',
    });
  });

  it('o endpoint sugerido usa o slug quando existe', async () => {
    gravarConfig({ apiUrl: 'https://api.exemplo.com' });
    programarFetch(
      resposta({ json: { api: { id: 'api_9', name: 'X', slug: 'meu-slug' } } }),
    );
    const r = await rodar('apis', 'create', urlPlanilha, '-n', 'X', '-s', 'meu-slug');
    expect(r.stdout.join('\n')).toContain(
      'Endpoint: https://api.exemplo.com/api/v1/meu-slug',
    );
  });

  it('sem slug, o endpoint sugerido cai no id', async () => {
    gravarConfig({ apiUrl: 'https://api.exemplo.com' });
    programarFetch(
      resposta({ json: { api: { id: 'api_9', name: 'X', slug: null } } }),
    );
    const r = await rodar('apis', 'create', urlPlanilha, '-n', 'X');
    expect(r.stdout.join('\n')).toContain(
      'Endpoint: https://api.exemplo.com/api/v1/api_9',
    );
  });

  it('erro da API sai com 1 e não anuncia criação', async () => {
    programarFetch(
      resposta({ ok: false, status: 400, json: { message: 'Invalid spreadsheet URL' } }),
    );
    const r = await rodar('apis', 'create', 'nao-e-url', '-n', 'X');
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toContain('Error: Invalid spreadsheet URL');
    expect(r.stdout.join('\n')).not.toContain('API created');
  });
});

describe('comando export', () => {
  it('formato default é json e vai na query string', async () => {
    programarFetch(resposta({ texto: '[]' }));
    await rodar('export', 'api_1');
    expect(ultimaChamadaFetch().url).toBe(
      'http://localhost:3000/api/v1/api_1/export?format=json',
    );
  });

  it('--format csv troca a query string', async () => {
    programarFetch(resposta({ texto: 'a,b\n1,2' }));
    await rodar('export', 'api_1', '--format', 'csv');
    expect(ultimaChamadaFetch().url).toContain('?format=csv');
  });

  it('ACHADO: --format não tem lista de valores válidos', async () => {
    // Não há `.choices(['json','csv'])`. Um erro de digitação sai daqui e só
    // é rejeitado pelo servidor, com mensagem que não cita a flag.
    programarFetch(resposta({ texto: '' }));
    await rodar('export', 'api_1', '--format', 'xlsx');
    expect(ultimaChamadaFetch().url).toContain('?format=xlsx');
  });

  it('sem --output, o conteúdo vai para stdout e nada é gravado', async () => {
    // É o que permite `sheets-banco export api_1 | jq`.
    programarFetch(resposta({ texto: '[{"a":1}]' }));
    const r = await rodar('export', 'api_1');
    expect(r.stdout.join('\n')).toContain('[{"a":1}]');
    expect(fsFalso.arquivos.size).toBe(0);
  });

  it('com --output grava o arquivo e confirma o caminho', async () => {
    programarFetch(resposta({ texto: 'a,b\n1,2' }));
    const r = await rodar('export', 'api_1', '-f', 'csv', '-o', 'dados.csv');
    expect(fsFalso.arquivos.get('dados.csv')).toBe('a,b\n1,2');
    expect(r.stdout.join('\n')).toContain('Exported to: dados.csv');
  });

  it('com --output o conteúdo NÃO é ecoado no terminal', async () => {
    // Contraponto do teste acima: exportar 50 mil linhas para arquivo e ainda
    // despejá-las na tela seria inutilizável.
    programarFetch(resposta({ texto: 'linha-secreta' }));
    const r = await rodar('export', 'api_1', '-o', 'dados.csv');
    expect(r.stdout.join('\n')).not.toContain('linha-secreta');
  });

  it('manda Authorization mas não manda Content-Type', async () => {
    // `export` não passa por `apiFetch`: monta os headers por conta própria.
    gravarConfig({ apiUrl: 'http://localhost:3000', token: 'tok-123' });
    programarFetch(resposta({ texto: '' }));
    await rodar('export', 'api_1');
    expect(ultimaChamadaFetch().init.headers).toEqual({
      Authorization: 'Bearer tok-123',
    });
  });

  it('erro da API sai com 1 e não grava arquivo', async () => {
    programarFetch(
      resposta({ ok: false, status: 404, json: { message: 'API not found' } }),
    );
    const r = await rodar('export', 'inexistente', '-o', 'dados.csv');
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toContain('Error: API not found');
    expect(fsFalso.arquivos.has('dados.csv')).toBe(false);
  });

  it('ACHADO: erro sem campo message imprime "Error: undefined"', async () => {
    // `apiFetch` tem o fallback `|| "Request failed"`; `export` não tem.
    programarFetch(resposta({ ok: false, status: 502, json: {} }));
    const r = await rodar('export', 'api_1');
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toContain('Error: undefined');
  });

  it('ACHADO: o api-id entra cru na URL, sem encodeURIComponent', async () => {
    programarFetch(resposta({ texto: '' }));
    await rodar('export', 'api_1?format=csv&x=1');
    expect(ultimaChamadaFetch().url).toBe(
      'http://localhost:3000/api/v1/api_1?format=csv&x=1/export?format=json',
    );
  });
});

describe('comando types — geração do arquivo TypeScript', () => {
  const schema = (colunas: Array<{ name: string; type: string }>) =>
    resposta({ json: { columns: colunas } });

  it('busca o schema em /api/v1/:id/schema', async () => {
    programarFetch(schema([{ name: 'nome', type: 'string' }]));
    await rodar('types', 'api_1');
    expect(ultimaChamadaFetch().url).toBe(
      'http://localhost:3000/api/v1/api_1/schema',
    );
  });

  it('manda o token como Bearer, sem Content-Type', async () => {
    // `types` também não passa por `apiFetch` — repete a montagem de header por
    // conta própria, e o schema de uma API protegida só volta com Authorization.
    gravarConfig({ apiUrl: 'http://localhost:3000', token: 'tok-123' });
    programarFetch(schema([]));
    await rodar('types', 'api_1');
    expect(ultimaChamadaFetch().init.headers).toEqual({
      Authorization: 'Bearer tok-123',
    });
  });

  it('grava em types.ts por default', async () => {
    programarFetch(schema([{ name: 'nome', type: 'string' }]));
    const r = await rodar('types', 'vendas');
    expect(fsFalso.arquivos.has('types.ts')).toBe(true);
    expect(r.stdout.join('\n')).toContain('Types generated: types.ts');
  });

  it('respeita --output', async () => {
    programarFetch(schema([{ name: 'nome', type: 'string' }]));
    await rodar('types', 'vendas', '-o', 'src/gerado/vendas.ts');
    expect(fsFalso.arquivos.has('src/gerado/vendas.ts')).toBe(true);
    expect(fsFalso.arquivos.has('types.ts')).toBe(false);
  });

  it('mapeia string, number e boolean para os tipos nativos', async () => {
    programarFetch(
      schema([
        { name: 'nome', type: 'string' },
        { name: 'total', type: 'number' },
        { name: 'ativo', type: 'boolean' },
      ]),
    );
    await rodar('types', 'vendas');
    expect(fsFalso.arquivos.get('types.ts')).toBe(
      '// Auto-generated by sheets-banco CLI\n' +
        '// API: vendas\n' +
        '\n' +
        'export interface VendasRow {\n' +
        '  nome: string;\n' +
        '  total: number;\n' +
        '  ativo: boolean;\n' +
        '}\n',
    );
  });

  it('tipo desconhecido vira string em vez de quebrar o arquivo', async () => {
    programarFetch(schema([{ name: 'criadoEm', type: 'date' }]));
    await rodar('types', 'vendas');
    expect(fsFalso.arquivos.get('types.ts')).toContain('  criadoEm: string;');
  });

  it('schema sem colunas gera interface vazia, e não erro', async () => {
    programarFetch(schema([]));
    await rodar('types', 'vendas');
    expect(fsFalso.arquivos.get('types.ts')).toContain(
      'export interface VendasRow {\n\n}',
    );
  });

  it('erro da API sai com 1 e não grava arquivo', async () => {
    programarFetch(
      resposta({ ok: false, status: 401, json: { message: 'Unauthorized' } }),
    );
    const r = await rodar('types', 'vendas');
    expect(r.saida).toBe(1);
    expect(r.stderr.join('\n')).toContain('Error: Unauthorized');
    expect(fsFalso.arquivos.has('types.ts')).toBe(false);
  });

  it('ACHADO: o nome da coluna entra cru — coluna com espaço gera TS inválido', async () => {
    // Cabeçalho de planilha quase sempre tem espaço ("Nome Completo"). O
    // arquivo gerado não compila e o erro só aparece no build de quem usa.
    programarFetch(schema([{ name: 'Nome Completo', type: 'string' }]));
    await rodar('types', 'vendas');
    expect(fsFalso.arquivos.get('types.ts')).toContain('  Nome Completo: string;');
  });

  it('ACHADO: tipo herdado de Object.prototype vaza para o arquivo', async () => {
    // `tsMap[col.type]` sem `Object.create(null)` nem `hasOwnProperty`: uma
    // coluna com type "constructor" resolve para a função e é interpolada.
    programarFetch(schema([{ name: 'x', type: 'constructor' }]));
    await rodar('types', 'vendas');
    expect(fsFalso.arquivos.get('types.ts')).toContain('x: function Object()');
  });
});

describe('comando types — derivação do nome da interface', () => {
  async function nomeGeradoPara(apiId: string): Promise<string> {
    programarFetch(resposta({ json: { columns: [] } }));
    const r = await rodar('types', '--', apiId);
    const linha = r.stdout.find((l) => l.startsWith('Interface: '));
    if (!linha) throw new Error(`Nenhum nome gerado. Saída: ${r.texto}`);
    return linha.replace('Interface: ', '');
  }

  it('id simples só ganha a inicial maiúscula', async () => {
    expect(await nomeGeradoPara('vendas')).toBe('VendasRow');
  });

  it('hífen vira camelCase', async () => {
    expect(await nomeGeradoPara('minha-api')).toBe('MinhaApiRow');
  });

  it('separadores nas pontas são descartados', async () => {
    expect(await nomeGeradoPara('_vendas_')).toBe('VendasRow');
  });

  it('ACHADO: separador duplo deixa um underscore no meio', async () => {
    // `/_(.)/g` consome o par, então `a--b` → `a__b` → `a_b` → `A_b`.
    expect(await nomeGeradoPara('a--b')).toBe('A_bRow');
  });

  it('ACHADO: id que começa com dígito gera interface inválida em TS', async () => {
    // Identificador TypeScript não pode começar com número. Um id do tipo
    // "2026-vendas" — ou um uuid começando com dígito — produz arquivo que
    // não compila.
    expect(await nomeGeradoPara('2026-vendas')).toBe('2026VendasRow');
  });

  it('ACHADO: id sem nenhum alfanumérico gera apenas "Row"', async () => {
    expect(await nomeGeradoPara('!!!')).toBe('Row');
  });

  it('o nome derivado é o mesmo que sai no arquivo', async () => {
    // Contraponto: sem isto, o log poderia estar certo e o arquivo errado.
    programarFetch(resposta({ json: { columns: [] } }));
    await rodar('types', 'minha-api');
    expect(fsFalso.arquivos.get('types.ts')).toContain(
      'export interface MinhaApiRow {',
    );
  });
});

describe('código de saída', () => {
  it('sucesso não chama process.exit', async () => {
    // Contraponto de todos os testes de erro: se o CLI saísse com 1 sempre, os
    // testes acima passariam do mesmo jeito.
    programarFetch(resposta({ json: { apis: [] } }));
    await rodar('apis', 'list');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('todo erro de API sai com 1, nunca com 0', async () => {
    for (const status of [400, 401, 403, 404, 500]) {
      programarFetch(resposta({ ok: false, status, json: { message: 'erro' } }));
      const r = await rodar('apis', 'list');
      expect(r.saida).toBe(1);
    }
  });

  it('ACHADO: API fora do ar não vira mensagem — a rejeição escapa do handler', async () => {
    // Cenário banal: o default é http://localhost:3000 e a API não está
    // rodando. Não há try/catch em volta do `fetch`, e `program.parse()`
    // DESCARTA a promessa do handler async (commander só devolve a cadeia em
    // `parseAsync`). Resultado em produção: unhandledRejection com stack trace
    // em vez de "Error: ...", e sem o `process.exit(1)` dos outros erros.
    //
    // Aqui a rejeição é observável porque o harness guardou a promessa; sem
    // isso o teste passaria "verde" com o erro sumindo em background.
    vi.mocked(globalThis.fetch).mockReset();
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:3000'),
    );
    await expect(rodar('apis', 'list')).rejects.toThrow(/ECONNREFUSED/);
    expect(process.exit).not.toHaveBeenCalled();
  });
});
