/**
 * Testes de caracterização de `routes/auth.ts` — registro, login e /me.
 *
 * "Caracterização" e não TDD: o código já existe e funciona. Estes testes
 * travam o comportamento ATUAL para que uma mudança futura não o altere sem
 * alguém perceber. TDD (teste falhando primeiro) vale para o que for escrito
 * daqui em diante.
 *
 * Por que importa: até aqui `auth.ts` tinha 0% de cobertura. É a rota que
 * emite JWT — um bug aqui é falha de segurança, não de funcionalidade.
 *
 * Prisma e googleapis são mockados: o objetivo é exercitar a LÓGICA da rota
 * (validação, códigos de status, o que entra e sai do corpo), não o driver do
 * banco.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import type { FastifyInstance } from 'fastify';

const usuarioDb = {
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

vi.mock('../lib/prisma.js', () => ({ prisma: { user: usuarioDb } }));

// googleapis é importado no topo de auth.ts para o fluxo OAuth. Sem este mock
// o import tenta resolver credenciais e o teste vira teste de rede.
vi.mock('googleapis', () => ({
  google: { auth: { OAuth2: class { generateAuthUrl() { return 'https://accounts.google.com/fake'; } } } },
}));

vi.mock('../config/env.js', () => ({
  env: {
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'segredo',
    GOOGLE_REDIRECT_URI: 'http://localhost/cb',
    FRONTEND_URL: 'http://localhost:3001',
    RATE_LIMIT_AUTH_MAX: 1000,
    RATE_LIMIT_AUTH_WINDOW: '1 minute',
  },
}));

const { montarApp, bearerDe, argDaChamada } = await import('../test-utils/app.js');
const { authRoutes } = await import('./auth.js');

let app: FastifyInstance;
let hashValido: string;

beforeEach(async () => {
  vi.clearAllMocks();
  hashValido = await bcrypt.hash('senha-correta', 4); // rounds baixos = teste rápido
  app = await montarApp({ rotas: authRoutes, prefixo: '/auth' });
});

describe('POST /auth/register', () => {
  it('cria usuário e devolve 201 com token', async () => {
    usuarioDb.findUnique.mockResolvedValue(null);
    usuarioDb.create.mockResolvedValue({
      id: 'u1', email: 'novo@ex.com', name: 'Novo', passwordHash: 'x',
    });

    const r = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'novo@ex.com', password: 'senha123', name: 'Novo' },
    });

    expect(r.statusCode).toBe(201);
    const corpo = r.json();
    expect(corpo.token).toBeTruthy();
    expect(corpo.user).toMatchObject({ id: 'u1', email: 'novo@ex.com', googleConnected: false });
    // A senha nunca pode voltar na resposta, nem em hash.
    expect(JSON.stringify(corpo)).not.toContain('passwordHash');
  });

  it('recusa e-mail já cadastrado com 409', async () => {
    usuarioDb.findUnique.mockResolvedValue({ id: 'existente', email: 'a@ex.com' });

    const r = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'a@ex.com', password: 'senha123' },
    });

    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('EMAIL_EXISTS');
    expect(usuarioDb.create).not.toHaveBeenCalled();
  });

  it('recusa senha com menos de 6 caracteres', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'a@ex.com', password: '12345' },
    });
    expect(r.statusCode).toBe(400);
    expect(usuarioDb.create).not.toHaveBeenCalled();
  });

  it('recusa e-mail malformado', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'nao-e-email', password: 'senha123' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('guarda a senha como hash bcrypt, nunca em texto puro', async () => {
    usuarioDb.findUnique.mockResolvedValue(null);
    usuarioDb.create.mockResolvedValue({ id: 'u1', email: 'a@ex.com', name: null });

    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'a@ex.com', password: 'minha-senha-secreta' },
    });

    const gravado = argDaChamada<{ data: { passwordHash: string } }>(usuarioDb.create).data.passwordHash;
    expect(gravado).not.toBe('minha-senha-secreta');
    expect(gravado.startsWith('$2')).toBe(true); // prefixo bcrypt
    expect(await bcrypt.compare('minha-senha-secreta', gravado)).toBe(true);
  });
});

describe('POST /auth/login', () => {
  it('devolve token quando a senha confere', async () => {
    usuarioDb.findUnique.mockResolvedValue({
      id: 'u1', email: 'a@ex.com', name: 'A', passwordHash: hashValido,
      totpEnabled: false, googleRefreshToken: null,
    });

    const r = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'a@ex.com', password: 'senha-correta' },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().token).toBeTruthy();
    expect(r.json().user.googleConnected).toBe(false);
  });

  it('marca googleConnected quando existe refresh token', async () => {
    usuarioDb.findUnique.mockResolvedValue({
      id: 'u1', email: 'a@ex.com', name: 'A', passwordHash: hashValido,
      totpEnabled: false, googleRefreshToken: 'gcm$abc',
    });

    const r = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'a@ex.com', password: 'senha-correta' },
    });
    expect(r.json().user.googleConnected).toBe(true);
  });

  it('senha errada dá 401', async () => {
    usuarioDb.findUnique.mockResolvedValue({
      id: 'u1', email: 'a@ex.com', passwordHash: hashValido, totpEnabled: false,
    });

    const r = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'a@ex.com', password: 'senha-errada' },
    });

    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('usuário inexistente dá o MESMO 401 de senha errada (não revela quem existe)', async () => {
    usuarioDb.findUnique.mockResolvedValue(null);

    const r = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ninguem@ex.com', password: 'qualquer' },
    });

    expect(r.statusCode).toBe(401);
    // Mensagem idêntica ao caso de senha errada: enumerar usuário por
    // diferença de resposta é falha clássica.
    expect(r.json().message).toBe('Invalid email or password.');
    expect(r.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('com 2FA ligado devolve tempToken e NÃO o token de sessão', async () => {
    usuarioDb.findUnique.mockResolvedValue({
      id: 'u1', email: 'a@ex.com', passwordHash: hashValido, totpEnabled: true,
    });

    const r = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'a@ex.com', password: 'senha-correta' },
    });

    const corpo = r.json();
    expect(corpo.requires2FA).toBe(true);
    expect(corpo.tempToken).toBeTruthy();
    // O token definitivo só pode sair depois do segundo fator.
    expect(corpo.token).toBeUndefined();

    const payload = app.jwt.verify(corpo.tempToken) as Record<string, unknown>;
    expect(payload.pending2fa).toBe(true);
    expect(payload.purpose).toBe('2fa_pending');
  });

  it('ACHADO: o tempToken do 2FA não abre rota protegida — o bypass, ponta a ponta', async () => {
    // O ataque completo, com as rotas reais e o `jwtAuth` real (este arquivo
    // não mocka o middleware, diferente de `auth-2fa.test.ts`):
    //
    //   1. atacante tem apenas a senha de uma conta com 2FA ligado;
    //   2. faz login e recebe `tempToken` na resposta — sem digitar TOTP;
    //   3. manda esse token como Bearer numa rota de sessão.
    //
    // O passo 3 respondia 200 antes de `lib/jwt-purpose.ts` existir, o que
    // anulava o segundo fator. Aqui ele tem que ser 401.
    usuarioDb.findUnique.mockResolvedValue({
      id: 'u1', email: 'a@ex.com', passwordHash: hashValido, totpEnabled: true,
    });

    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'a@ex.com', password: 'senha-correta' },
    });
    const { tempToken } = login.json();

    const comTempToken = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${tempToken}` },
    });

    expect(comTempToken.statusCode).toBe(401);
    expect(comTempToken.json().code).toBe('TOKEN_WRONG_PURPOSE');
  });
});

describe('GET /auth/me', () => {
  it('sem token dá 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(r.statusCode).toBe(401);
  });

  it('com token válido devolve o usuário', async () => {
    usuarioDb.findUnique.mockResolvedValue({
      id: 'u1', email: 'a@ex.com', name: 'A', googleRefreshToken: null, totpEnabled: false,
    });

    const r = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: bearerDe(app, { sub: 'u1', email: 'a@ex.com' }) },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().user.email).toBe('a@ex.com');
  });

  it('token assinado com outro segredo dá 401', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.assinatura-falsa' },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('conectar Google sem pôr o token na URL', () => {
  it('POST /auth/google/url devolve a URL de consentimento para quem tem sessão', async () => {
    const r = await app.inject({
      method: 'POST', url: '/auth/google/url',
      headers: { authorization: bearerDe(app, { sub: 'u1', email: 'a@ex.com', purpose: 'session' }) },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().url).toContain('accounts.google.com');
  });

  it('POST /auth/google/url exige sessão', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/google/url' });
    expect(r.statusCode).toBe(401);
  });

  it('POST /auth/google/url recusa o tempToken do 2FA', async () => {
    const r = await app.inject({
      method: 'POST', url: '/auth/google/url',
      headers: { authorization: bearerDe(app, { sub: 'u1', email: 'a@ex.com', pending2fa: true }) },
    });

    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('TOKEN_WRONG_PURPOSE');
  });

  it('a URL não carrega segredo nosso — só o state, que é o id do usuário', async () => {
    // O ponto do endpoint: o navegador vai para uma URL do Google, e o token de
    // sessão fica no header desta chamada, fora da barra de endereço.
    const r = await app.inject({
      method: 'POST', url: '/auth/google/url',
      headers: { authorization: bearerDe(app, { sub: 'u1', email: 'a@ex.com', purpose: 'session' }) },
    });

    expect(r.json().url).not.toContain('eyJ'); // prefixo de JWT em base64url
  });
});

describe('GET /auth/google — caminho antigo, mantido por um release', () => {
  it('sem token redireciona para o consentimento (fluxo de login)', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/google' });

    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toContain('accounts.google.com');
  });

  it('com token de sessão em ?token= ainda funciona', async () => {
    // Depreciado, não removido: API (Render) e dashboard (Vercel) sobem em
    // deploys separados do mesmo merge, e derrubar isto junto com a mudança do
    // front quebraria "conectar Google" na janela entre os dois.
    const token = bearerDe(app, { sub: 'u1', email: 'a@ex.com', purpose: 'session' }).slice(7);
    const r = await app.inject({ method: 'GET', url: `/auth/google?token=${token}` });

    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toContain('accounts.google.com');
  });

  it('ACHADO: recusa o tempToken do 2FA em ?token=', async () => {
    // Este caminho verificava o token com `app.jwt.verify` direto, sem olhar o
    // propósito. Sem o `ehTokenDeSessao`, quem tivesse só a senha ligava uma
    // conta Google — e passava a ter o OAuth da vítima — sem digitar o TOTP.
    const temp = bearerDe(app, { sub: 'u1', email: 'a@ex.com', pending2fa: true }).slice(7);
    const r = await app.inject({ method: 'GET', url: `/auth/google?token=${temp}` });

    expect(r.statusCode).toBe(401);
  });

  it('token inválido em ?token= dá 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/google?token=nao-e-jwt' });
    expect(r.statusCode).toBe(401);
  });
});

describe('POST /auth/google/exchange', () => {
  function codigoDeTroca(over: Record<string, unknown> = {}, opts?: { expiresIn: string }) {
    return app.jwt.sign(
      { sub: 'u1', email: 'a@ex.com', purpose: 'oauth_exchange', ...over },
      opts ?? { expiresIn: '60s' },
    );
  }

  it('troca o código por uma sessão', async () => {
    usuarioDb.findUnique.mockResolvedValue({
      id: 'u1', email: 'a@ex.com', name: 'A', googleRefreshToken: 'gcm$abc',
    });

    const r = await app.inject({
      method: 'POST', url: '/auth/google/exchange',
      payload: { code: codigoDeTroca() },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().user.googleConnected).toBe(true);

    const sessao = app.jwt.verify(r.json().token) as Record<string, unknown>;
    expect(sessao.purpose).toBe('session');
    expect(sessao.sub).toBe('u1');
  });

  it('ACHADO: o código de troca NÃO abre rota de sessão sozinho', async () => {
    // É por isso que ele pode viajar na URL. Se valesse como sessão, teríamos
    // trocado um JWT de 24h na barra de endereço por um de 60s — melhor, mas
    // ainda uma credencial exposta.
    const r = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${codigoDeTroca()}` },
    });

    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('TOKEN_WRONG_PURPOSE');
  });

  it('recusa um token de SESSÃO apresentado como código', async () => {
    // O inverso do caso acima: o endpoint de troca não pode ser um jeito de
    // renovar sessão indefinidamente a partir de uma sessão já existente.
    const sessao = app.jwt.sign({ sub: 'u1', email: 'a@ex.com', purpose: 'session' });

    const r = await app.inject({
      method: 'POST', url: '/auth/google/exchange', payload: { code: sessao },
    });

    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('INVALID_EXCHANGE_CODE');
  });

  it('recusa código expirado', async () => {
    const r = await app.inject({
      method: 'POST', url: '/auth/google/exchange',
      payload: { code: codigoDeTroca({}, { expiresIn: '-1s' }) },
    });

    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('INVALID_EXCHANGE_CODE');
  });

  it('recusa código que não é JWT', async () => {
    const r = await app.inject({
      method: 'POST', url: '/auth/google/exchange', payload: { code: 'lixo' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('sem código dá 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/google/exchange', payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it('código válido de usuário que não existe mais dá 401', async () => {
    usuarioDb.findUnique.mockResolvedValue(null);

    const r = await app.inject({
      method: 'POST', url: '/auth/google/exchange', payload: { code: codigoDeTroca() },
    });

    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('INVALID_EXCHANGE_CODE');
  });

  it('a mensagem é a mesma para código inválido, expirado e usuário sumido', async () => {
    // Diferenciar aqui contaria a quem tenta adivinhar em que ponto errou.
    usuarioDb.findUnique.mockResolvedValue(null);
    const sumido = await app.inject({
      method: 'POST', url: '/auth/google/exchange', payload: { code: codigoDeTroca() },
    });
    const invalido = await app.inject({
      method: 'POST', url: '/auth/google/exchange', payload: { code: 'lixo' },
    });

    expect(sumido.json().message).toBe(invalido.json().message);
  });
});

describe('rate limit cobre as rotas novas', () => {
  /**
   * O CodeQL abriu `js/missing-rate-limiting` (alerta #61) sobre o
   * `/auth/google/exchange`, dizendo que ele "performs authorization, but is
   * not rate-limited". É falso positivo — mas não havia teste nenhum provando
   * isso, então a afirmação valia tanto quanto o alerta.
   *
   * `authRateLimitOptions()` tem `global: true, max: 10`, e o
   * `app.register(import('@fastify/rate-limit'))` no topo de `authRoutes` vale
   * para todo o escopo encapsulado — inclusive rotas registradas depois dele.
   * Isto exercita o limite de verdade, com o plugin real.
   */
  async function dispararVezes(url: string, vezes: number, payload?: unknown) {
    const respostas = [];
    for (let i = 0; i < vezes; i++) {
      respostas.push(
        await app.inject({ method: 'POST', url, payload: payload ?? {} }),
      );
    }
    return respostas;
  }

  it('/auth/google/exchange responde 429 depois do 10º pedido no minuto', async () => {
    const respostas = await dispararVezes('/auth/google/exchange', 12, { code: 'x' });
    const status = respostas.map((r) => r.statusCode);

    expect(status.filter((s) => s === 429).length).toBeGreaterThan(0);
    // E os primeiros passaram: senão o teste provaria só que a rota está quebrada.
    expect(status[0]).not.toBe(429);
  });

  it('/auth/google/url também é coberto', async () => {
    const respostas = await dispararVezes('/auth/google/url', 12);
    expect(respostas.map((r) => r.statusCode).filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('o limite é por IP, com prefixo próprio de auth', async () => {
    // Contraponto: se a chave fosse global, um cliente derrubaria o login de
    // todo mundo; se não tivesse prefixo, o balde de auth se misturaria ao das
    // rotas de dashboard.
    const daqui = await dispararVezes('/auth/google/exchange', 12, { code: 'x' });
    expect(daqui.some((r) => r.statusCode === 429)).toBe(true);

    const deOutroIp = await app.inject({
      method: 'POST', url: '/auth/google/exchange',
      payload: { code: 'x' },
      remoteAddress: '198.51.100.9',
    });
    expect(deOutroIp.statusCode).not.toBe(429);
  });
});
