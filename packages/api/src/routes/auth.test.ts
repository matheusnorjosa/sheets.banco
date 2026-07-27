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
