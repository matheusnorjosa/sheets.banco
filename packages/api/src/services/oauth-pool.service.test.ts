/**
 * Testes de caracterização de `services/oauth-pool.service.ts`.
 *
 * "Caracterização" e não TDD: o código já existe. Estes testes travam o
 * comportamento de HOJE para que uma mudança futura não o altere sem alguém
 * perceber.
 *
 * Por que este arquivo merece teste: é onde o token OAuth do Google vive.
 * O PR #115 passou a criptografar o token em repouso, e a garantia que o
 * código precisa sustentar é dupla e assimétrica:
 *
 *   - para o CLIENTE Google (`setCredentials`) vai o token EM CLARO;
 *   - para o REDIS (`cache.set`) e para o POSTGRES (`prisma.user.update`)
 *     vai o envelope `gcm$…`.
 *
 * Se essa assimetria inverter, ou o Google recebe lixo (quebra em produção)
 * ou o token vaza em texto claro num dump de Redis/DB. Por isso o
 * `secret-cipher` NÃO é mockado aqui: a cifra de verdade roda, e a prova é
 * `isEncrypted()` + `decrypt()` batendo no valor original. Com a cifra
 * mockada o teste passaria mesmo com a criptografia quebrada.
 *
 * Mockados (fronteiras de I/O, não são o alvo): `googleapis`, `prisma`,
 * `cache.service` e `config/env` (que valida env na importação e explode sem
 * `DATABASE_URL`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

// A cifra real precisa de chave. Definida ANTES de qualquer import do módulo
// sob teste porque `secret-cipher` memoiza a chave na primeira chamada.
process.env.SECRETS_ENC_KEY = crypto.randomBytes(32).toString('hex');

type Ouvinte = (...args: unknown[]) => unknown;

/**
 * Dublê do `google.auth.OAuth2`. Guarda o que recebeu em `setCredentials`,
 * expõe o handler registrado em `on('tokens', …)` e mantém `credentials`
 * coerente — o código sob teste lê `oauth2Client.credentials.access_token`
 * como fallback ao persistir um refresh.
 */
class ClienteOAuthFalso {
  credentials: Record<string, unknown> = {};
  ouvintes = new Map<string, Ouvinte>();
  argsDoConstrutor: unknown[];

  setCredentials = vi.fn((creds: Record<string, unknown>) => {
    this.credentials = { ...this.credentials, ...creds };
  });

  on = vi.fn((evento: string, handler: Ouvinte) => {
    this.ouvintes.set(evento, handler);
    return this;
  });

  constructor(...args: unknown[]) {
    this.argsDoConstrutor = args;
    instancias.push(this);
  }

  /** Simula o refresh automático do google-auth-library. */
  async dispararTokens(tokens: Record<string, unknown>): Promise<void> {
    const handler = this.ouvintes.get('tokens');
    if (!handler) throw new Error('Nenhum ouvinte de "tokens" foi registrado.');
    await handler(tokens);
  }
}

const instancias: ClienteOAuthFalso[] = [];

const usuarioDb = { findUnique: vi.fn(), update: vi.fn() };
const cacheGet = vi.fn();
const cacheSet = vi.fn();
const cacheDel = vi.fn();

vi.mock('googleapis', () => ({
  google: { auth: { OAuth2: ClienteOAuthFalso } },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: { user: usuarioDb } }));

vi.mock('./cache.service.js', () => ({
  get: cacheGet,
  set: cacheSet,
  del: cacheDel,
}));

vi.mock('../config/env.js', () => ({
  env: {
    GOOGLE_CLIENT_ID: 'id-de-teste',
    GOOGLE_CLIENT_SECRET: 'segredo-de-teste',
    GOOGLE_REDIRECT_URI: 'http://localhost/cb',
  },
}));

const { argDaChamada } = await import('../test-utils/app.js');
const { encrypt, decrypt, isEncrypted } = await import('../lib/secret-cipher.js');
const { getOAuthClient, invalidateOAuthCache } = await import('./oauth-pool.service.js');
const { AppError } = await import('../lib/errors.js');

const USER_ID = 'user-1';
const CHAVE = `oauth:${USER_ID}`;

/** Credenciais que o código mandou para o cliente Google. */
interface CredsGoogle {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number | null;
}

/** Forma do objeto que vai para o Redis. */
interface CredsCache {
  accessToken: string;
  refreshToken: string;
  expiryDate: number | null;
}

/** Monta um envelope `gcm$` válido, porém com uma chave que não é a nossa. */
function cifrarComOutraChave(texto: string): string {
  const chave = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const ct = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()]);
  const tag = cifra.getAuthTag();
  return `gcm$${iv.toString('base64url')}$${ct.toString('base64url')}$${tag.toString('base64url')}`;
}

function ultimoCliente(): ClienteOAuthFalso {
  const cliente = instancias.at(-1);
  if (!cliente) throw new Error('Nenhum cliente OAuth foi construído.');
  return cliente;
}

/** Lê o objeto entregue ao `cache.set` numa chamada específica. */
function credsDoCache(chamada = 0): CredsCache {
  return argDaChamada<CredsCache>(cacheSet, chamada, 1);
}

/** Lê o TTL (3º argumento) entregue ao `cache.set`. */
function ttlDoCache(chamada = 0): number {
  return argDaChamada<number>(cacheSet, chamada, 2);
}

beforeAll(() => {
  expect(process.env.SECRETS_ENC_KEY).toMatch(/^[0-9a-f]{64}$/);
});

beforeEach(() => {
  vi.clearAllMocks();
  instancias.length = 0;
  usuarioDb.update.mockResolvedValue({});
  cacheSet.mockResolvedValue(undefined);
  cacheDel.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getOAuthClient — cache hit', () => {
  it('decifra o que veio do Redis antes de entregar ao cliente Google', async () => {
    const expiry = Date.now() + 30 * 60 * 1000;
    cacheGet.mockResolvedValue({
      accessToken: encrypt('at-em-claro'),
      refreshToken: encrypt('rt-em-claro'),
      expiryDate: expiry,
    });

    await getOAuthClient(USER_ID);

    const cliente = ultimoCliente();
    const creds = argDaChamada<CredsGoogle>(cliente.setCredentials);

    // O Google tem que receber o token USÁVEL, não o envelope.
    expect(creds.access_token).toBe('at-em-claro');
    expect(creds.refresh_token).toBe('rt-em-claro');
    expect(creds.expiry_date).toBe(expiry);
    expect(isEncrypted(creds.access_token)).toBe(false);
    expect(isEncrypted(creds.refresh_token)).toBe(false);
  });

  it('usa a chave `oauth:<userId>` e não toca no banco nem regrava o cache', async () => {
    cacheGet.mockResolvedValue({
      accessToken: encrypt('at'),
      refreshToken: encrypt('rt'),
      expiryDate: null,
    });

    await getOAuthClient(USER_ID);

    expect(argDaChamada<string>(cacheGet)).toBe(CHAVE);
    expect(usuarioDb.findUnique).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it('dual-read: valor legado em texto claro no cache passa direto', async () => {
    // Janela de migração — o cache pode ter sido escrito antes do PR #115.
    cacheGet.mockResolvedValue({
      accessToken: 'legado-em-claro',
      refreshToken: 'rt-legado',
      expiryDate: null,
    });

    await getOAuthClient(USER_ID);

    const creds = argDaChamada<CredsGoogle>(ultimoCliente().setCredentials);
    expect(creds.access_token).toBe('legado-em-claro');
    expect(creds.refresh_token).toBe('rt-legado');
  });

  it('constrói o cliente com as credenciais OAuth do env', async () => {
    cacheGet.mockResolvedValue({
      accessToken: encrypt('at'),
      refreshToken: encrypt('rt'),
      expiryDate: null,
    });

    await getOAuthClient(USER_ID);

    expect(ultimoCliente().argsDoConstrutor).toEqual([
      'id-de-teste',
      'segredo-de-teste',
      'http://localhost/cb',
    ]);
  });
});

describe('getOAuthClient — envelope que não abre com a chave atual', () => {
  it('erro CRU (não AppError) e o cache envenenado NÃO é invalidado', async () => {
    // Cenário de rotação de SECRETS_ENC_KEY: o Redis guarda um envelope da
    // chave antiga. O código não trata — `decrypt` estoura e o erro sobe cru,
    // sem virar 403/500 com código. Pior: a entrada ruim continua no cache,
    // então toda requisição do usuário falha até o TTL expirar.
    cacheGet.mockResolvedValue({
      accessToken: cifrarComOutraChave('at'),
      refreshToken: encrypt('rt'),
      expiryDate: null,
    });

    const erro: unknown = await getOAuthClient(USER_ID).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(Error);
    expect(erro).not.toBeInstanceOf(AppError);
    expect(cacheDel).not.toHaveBeenCalled();
    expect(usuarioDb.findUnique).not.toHaveBeenCalled();
  });
});

describe('getOAuthClient — cache miss (lê do Postgres)', () => {
  it('decifra para o Google e regrava no Redis a forma CRIPTOGRAFADA', async () => {
    const expiry = new Date(Date.now() + 30 * 60 * 1000);
    cacheGet.mockResolvedValue(undefined);
    usuarioDb.findUnique.mockResolvedValue({
      id: USER_ID,
      googleAccessToken: encrypt('at-do-banco'),
      googleRefreshToken: encrypt('rt-do-banco'),
      googleTokenExpiry: expiry,
    });

    await getOAuthClient(USER_ID);

    // 1) Google recebe em claro.
    const creds = argDaChamada<CredsGoogle>(ultimoCliente().setCredentials);
    expect(creds.access_token).toBe('at-do-banco');
    expect(creds.refresh_token).toBe('rt-do-banco');
    expect(creds.expiry_date).toBe(expiry.getTime());

    // 2) Redis recebe o envelope — e o envelope decifra no token certo.
    const doCache = credsDoCache();
    expect(isEncrypted(doCache.accessToken)).toBe(true);
    expect(isEncrypted(doCache.refreshToken)).toBe(true);
    expect(decrypt(doCache.accessToken)).toBe('at-do-banco');
    expect(decrypt(doCache.refreshToken)).toBe('rt-do-banco');
    expect(doCache.expiryDate).toBe(expiry.getTime());

    // 3) Nada de texto claro no payload serializado que vai pro Redis.
    const serializado = JSON.stringify(doCache);
    expect(serializado).not.toContain('at-do-banco');
    expect(serializado).not.toContain('rt-do-banco');

    expect(argDaChamada<string>(cacheSet)).toBe(CHAVE);
    expect(argDaChamada<{ where: { id: string } }>(usuarioDb.findUnique)).toEqual({
      where: { id: USER_ID },
    });
  });

  it('sem expiry no banco, manda expiry_date null para o Google e para o cache', async () => {
    cacheGet.mockResolvedValue(undefined);
    usuarioDb.findUnique.mockResolvedValue({
      googleAccessToken: encrypt('at'),
      googleRefreshToken: encrypt('rt'),
      googleTokenExpiry: null,
    });

    await getOAuthClient(USER_ID);

    expect(argDaChamada<CredsGoogle>(ultimoCliente().setCredentials).expiry_date).toBeNull();
    expect(credsDoCache().expiryDate).toBeNull();
  });

  it('ATENÇÃO: token legado em texto claro no banco é copiado em claro para o Redis', async () => {
    // Caracterização de um efeito colateral do dual-read: o cache reflete o
    // que está EM REPOUSO, sem cifrar. Enquanto o backfill não rodar, uma
    // linha legada continua espalhando texto claro para o Redis.
    cacheGet.mockResolvedValue(undefined);
    usuarioDb.findUnique.mockResolvedValue({
      googleAccessToken: 'at-legado-em-claro',
      googleRefreshToken: 'rt-legado-em-claro',
      googleTokenExpiry: null,
    });

    await getOAuthClient(USER_ID);

    const doCache = credsDoCache();
    expect(isEncrypted(doCache.accessToken)).toBe(false);
    expect(doCache.accessToken).toBe('at-legado-em-claro');
  });
});

describe('getOAuthClient — usuário sem Google conectado', () => {
  const casos: Array<[string, unknown]> = [
    ['usuário inexistente', null],
    ['sem access token', { googleAccessToken: null, googleRefreshToken: encrypt('rt') }],
    ['sem refresh token', { googleAccessToken: encrypt('at'), googleRefreshToken: null }],
    ['tokens vazios', { googleAccessToken: '', googleRefreshToken: '' }],
  ];

  for (const [descricao, usuario] of casos) {
    it(`lança AppError 403 GOOGLE_NOT_CONNECTED — ${descricao}`, async () => {
      cacheGet.mockResolvedValue(undefined);
      usuarioDb.findUnique.mockResolvedValue(usuario);

      await expect(getOAuthClient(USER_ID)).rejects.toBeInstanceOf(AppError);
      await expect(getOAuthClient(USER_ID)).rejects.toMatchObject({
        statusCode: 403,
        code: 'GOOGLE_NOT_CONNECTED',
      });
      expect(cacheSet).not.toHaveBeenCalled();
    });
  }
});

describe('evento `tokens` (refresh automático)', () => {
  async function clienteComCacheHit(): Promise<ClienteOAuthFalso> {
    cacheGet.mockResolvedValue({
      accessToken: encrypt('at-antigo'),
      refreshToken: encrypt('rt-antigo'),
      expiryDate: Date.now() + 60_000,
    });
    await getOAuthClient(USER_ID);
    return ultimoCliente();
  }

  it('registra um ouvinte de `tokens` também no caminho de cache hit', async () => {
    const cliente = await clienteComCacheHit();
    expect(cliente.on).toHaveBeenCalledWith('tokens', expect.any(Function));
  });

  it('persiste no Postgres CRIPTOGRAFADO e recacheia CRIPTOGRAFADO', async () => {
    const cliente = await clienteComCacheHit();
    const novoExpiry = Date.now() + 45 * 60 * 1000;

    await cliente.dispararTokens({
      access_token: 'at-novinho',
      refresh_token: 'rt-novinho',
      expiry_date: novoExpiry,
    });

    // Postgres
    const update = argDaChamada<{
      where: { id: string };
      data: { googleAccessToken: string; googleRefreshToken: string; googleTokenExpiry: Date };
    }>(usuarioDb.update);
    expect(update.where).toEqual({ id: USER_ID });
    expect(isEncrypted(update.data.googleAccessToken)).toBe(true);
    expect(isEncrypted(update.data.googleRefreshToken)).toBe(true);
    expect(decrypt(update.data.googleAccessToken)).toBe('at-novinho');
    expect(decrypt(update.data.googleRefreshToken)).toBe('rt-novinho');
    expect(update.data.googleTokenExpiry).toEqual(new Date(novoExpiry));
    expect(JSON.stringify(update.data)).not.toContain('at-novinho');

    // Redis (o cache hit não gravou nada, então esta é a 1ª chamada)
    const doCache = credsDoCache();
    expect(isEncrypted(doCache.accessToken)).toBe(true);
    expect(isEncrypted(doCache.refreshToken)).toBe(true);
    expect(decrypt(doCache.accessToken)).toBe('at-novinho');
    expect(decrypt(doCache.refreshToken)).toBe('rt-novinho');
    expect(doCache.expiryDate).toBe(novoExpiry);
    expect(JSON.stringify(doCache)).not.toContain('rt-novinho');
  });

  it('só access_token: grava apenas essa coluna e reaproveita o refresh do cliente', async () => {
    const cliente = await clienteComCacheHit();

    await cliente.dispararTokens({ access_token: 'só-o-access' });

    const update = argDaChamada<{ data: Record<string, unknown> }>(usuarioDb.update);
    expect(Object.keys(update.data)).toEqual(['googleAccessToken']);

    // O refresh vem do fallback `oauth2Client.credentials.refresh_token`,
    // que estava em claro no cliente — e é recifrado antes de ir ao Redis.
    const doCache = credsDoCache();
    expect(decrypt(doCache.accessToken)).toBe('só-o-access');
    expect(decrypt(doCache.refreshToken)).toBe('rt-antigo');
    expect(doCache.expiryDate).toBeNull();
  });

  it('sem nada útil (objeto vazio) NÃO chama prisma.user.update nem cache.set', async () => {
    const cliente = await clienteComCacheHit();

    await cliente.dispararTokens({});

    expect(usuarioDb.update).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it('campos falsy (string vazia, expiry 0) contam como "nada útil"', async () => {
    const cliente = await clienteComCacheHit();

    await cliente.dispararTokens({ access_token: '', refresh_token: '', expiry_date: 0 });

    expect(usuarioDb.update).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it('só expiry_date + cache sem tokens → recacheia string VAZIA cifrada', async () => {
    // Entrada de cache degenerada (payload gravado por uma versão anterior,
    // por exemplo). O código tem o fallback `?? ''`: em vez de pular a
    // regravação, ele cifra string vazia e sobrescreve o cache com ela.
    cacheGet.mockResolvedValue({ expiryDate: null });
    await getOAuthClient(USER_ID);
    const cliente = ultimoCliente();

    await cliente.dispararTokens({ expiry_date: Date.now() + 30 * 60 * 1000 });

    const update = argDaChamada<{ data: Record<string, unknown> }>(usuarioDb.update);
    expect(Object.keys(update.data)).toEqual(['googleTokenExpiry']);

    const doCache = credsDoCache();
    expect(isEncrypted(doCache.accessToken)).toBe(true);
    expect(decrypt(doCache.accessToken)).toBe('');
    expect(decrypt(doCache.refreshToken)).toBe('');
  });

  it('erro do Postgres escapa do ouvinte (promessa rejeitada, sem try/catch)', async () => {
    const cliente = await clienteComCacheHit();
    usuarioDb.update.mockRejectedValue(new Error('conexão caiu'));

    // Aqui o teste chama o handler diretamente e consegue capturar. Em
    // produção quem chama é o EventEmitter, que descarta a promessa: vira
    // unhandledRejection.
    await expect(cliente.dispararTokens({ access_token: 'x' })).rejects.toThrow('conexão caiu');
    expect(cacheSet).not.toHaveBeenCalled();
  });
});

describe('TTL do cache (computeTtl, exercitado pelo 3º argumento de cache.set)', () => {
  const AGORA = new Date('2026-07-27T12:00:00.000Z');

  beforeEach(() => {
    // Só o relógio é falsificado: nada aqui depende de timers reais, e travar
    // `Date.now()` tira o teste da dependência do relógio de parede.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA);
    cacheGet.mockResolvedValue(undefined);
  });

  async function ttlParaExpiry(expiry: Date | null): Promise<number> {
    usuarioDb.findUnique.mockResolvedValue({
      googleAccessToken: encrypt('at'),
      googleRefreshToken: encrypt('rt'),
      googleTokenExpiry: expiry,
    });
    await getOAuthClient(USER_ID);
    return ttlDoCache();
  }

  it('sem expiry → 3000s (50 min, o padrão)', async () => {
    expect(await ttlParaExpiry(null)).toBe(3000);
  });

  it('expiry muito distante → teto de 3000s', async () => {
    expect(await ttlParaExpiry(new Date(AGORA.getTime() + 10 * 24 * 3600 * 1000))).toBe(3000);
  });

  it('expiry em ~10 min → 300s (expiry menos a margem de 5 min)', async () => {
    expect(await ttlParaExpiry(new Date(AGORA.getTime() + 10 * 60 * 1000))).toBe(300);
  });

  it('expiry já vencido → piso de 60s', async () => {
    expect(await ttlParaExpiry(new Date(AGORA.getTime() - 60 * 60 * 1000))).toBe(60);
  });

  it('expiry em 6 min (limite da margem) → piso de 60s', async () => {
    expect(await ttlParaExpiry(new Date(AGORA.getTime() + 6 * 60 * 1000))).toBe(60);
  });

  it('no refresh: sem expiry_date nos tokens → 3000s fixo', async () => {
    usuarioDb.findUnique.mockResolvedValue({
      googleAccessToken: encrypt('at'),
      googleRefreshToken: encrypt('rt'),
      googleTokenExpiry: null,
    });
    await getOAuthClient(USER_ID);
    cacheSet.mockClear();

    await ultimoCliente().dispararTokens({ access_token: 'novo' });

    expect(ttlDoCache()).toBe(3000);
  });

  it('no refresh: com expiry_date, o TTL sai do mesmo computeTtl', async () => {
    usuarioDb.findUnique.mockResolvedValue({
      googleAccessToken: encrypt('at'),
      googleRefreshToken: encrypt('rt'),
      googleTokenExpiry: null,
    });
    await getOAuthClient(USER_ID);
    cacheSet.mockClear();

    await ultimoCliente().dispararTokens({
      access_token: 'novo',
      expiry_date: AGORA.getTime() + 10 * 60 * 1000,
    });

    expect(ttlDoCache()).toBe(300);
  });
});

describe('invalidateOAuthCache', () => {
  it('apaga exatamente a chave `oauth:<userId>`', async () => {
    await invalidateOAuthCache(USER_ID);

    expect(cacheDel).toHaveBeenCalledTimes(1);
    expect(argDaChamada<string>(cacheDel)).toBe(CHAVE);
  });

  it('não toca no banco', async () => {
    await invalidateOAuthCache('outro-usuario');

    expect(argDaChamada<string>(cacheDel)).toBe('oauth:outro-usuario');
    expect(usuarioDb.update).not.toHaveBeenCalled();
    expect(usuarioDb.findUnique).not.toHaveBeenCalled();
  });
});
