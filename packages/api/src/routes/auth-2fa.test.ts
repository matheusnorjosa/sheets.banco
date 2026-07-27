/**
 * Testes de caracterização de `routes/auth-2fa.ts` — o segundo fator.
 *
 * Decisão importante: o TOTP **não** é mockado. Os testes geram um código
 * válido de verdade com a mesma biblioteca (`otpauth`) a partir do segredo
 * do usuário. Mockar `totp.validate()` faria os testes passarem mesmo com a
 * validação quebrada — que é justamente o que não se pode deixar acontecer
 * num segundo fator.
 *
 * O que está coberto, por ordem de gravidade se falhar:
 *   1. `/2fa/validate` — o portão do login. Código errado não pode emitir
 *      token; token sem `pending2fa` não pode ser aceito (senão qualquer JWT
 *      viraria bypass do 2FA).
 *   2. Código de recuperação é de USO ÚNICO — depois de usado, sai da lista.
 *   3. `/2fa/disable` exige a senha: sem isso, uma sessão roubada desligaria
 *      o segundo fator sozinha.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';

const usuarioDb = { findUnique: vi.fn(), update: vi.fn() };
vi.mock('../lib/prisma.js', () => ({ prisma: { user: usuarioDb } }));

vi.mock('../config/env.js', () => ({
  env: { RATE_LIMIT_AUTH_MAX: 1000, RATE_LIMIT_AUTH_WINDOW: '1 minute' },
}));

// jwtAuth real precisaria do plugin completo; as rotas só consomem
// `request.user.sub`. O `/2fa/validate` NÃO usa jwtAuth (é chamado antes de
// haver sessão), então esse mock não interfere no teste mais importante.
vi.mock('../middleware/jwt-auth.js', () => ({
  jwtAuth: async (request: { user?: unknown }) => {
    request.user = { sub: 'u1' };
  },
}));

const { montarApp, argDaChamada } = await import('../test-utils/app.js');
const { auth2faRoutes } = await import('./auth-2fa.js');

let app: FastifyInstance;
let segredo: string;
let hashSenha: string;

/** Código TOTP válido AGORA para o segredo dado — mesma lib que a rota usa. */
function codigoValido(secretBase32: string): string {
  return new OTPAuth.TOTP({
    issuer: 'sheets.banco',
    label: 'a@ex.com',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate();
}

function usuario(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'a@ex.com',
    name: 'A',
    passwordHash: hashSenha,
    totpSecret: segredo,
    totpEnabled: true,
    recoveryCodes: [] as string[],
    googleRefreshToken: null,
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  segredo = new OTPAuth.Secret({ size: 20 }).base32;
  hashSenha = await bcrypt.hash('senha-correta', 4);
  usuarioDb.update.mockResolvedValue({});
  app = await montarApp({ rotas: auth2faRoutes, prefixo: '/auth' });
});

describe('POST /auth/2fa/setup', () => {
  it('gera segredo e QR code, mas ainda NÃO habilita o 2FA', async () => {
    usuarioDb.findUnique.mockResolvedValue(usuario({ totpEnabled: false, totpSecret: null }));

    const r = await app.inject({ method: 'POST', url: '/auth/2fa/setup' });

    expect(r.statusCode).toBe(200);
    const corpo = r.json();
    expect(corpo.secret).toBeTruthy();
    expect(corpo.qrCode).toContain('data:image');

    // O 2FA só liga depois do /verify: se ligasse aqui, um setup abandonado
    // trancaria o usuário para fora da própria conta.
    const gravado = argDaChamada<{ data: { totpEnabled?: boolean } }>(usuarioDb.update).data;
    expect(gravado.totpEnabled).not.toBe(true);
  });
});

describe('POST /auth/2fa/verify — liga o 2FA', () => {
  it('com código válido, habilita e devolve os códigos de recuperação', async () => {
    usuarioDb.findUnique.mockResolvedValue(usuario({ totpEnabled: false }));

    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/verify',
      payload: { code: codigoValido(segredo) },
    });

    expect(r.statusCode).toBe(200);
    const corpo = r.json();
    expect(corpo.enabled).toBe(true);
    expect(corpo.recoveryCodes).toHaveLength(10);

    const gravado = argDaChamada<{ data: { totpEnabled: boolean; recoveryCodes: string[] } }>(usuarioDb.update).data;
    expect(gravado.totpEnabled).toBe(true);
    // Os códigos vão para o banco em bcrypt; o texto puro só existe nesta
    // resposta, uma única vez.
    expect(gravado.recoveryCodes).toHaveLength(10);
    for (const guardado of gravado.recoveryCodes) {
      expect(guardado.startsWith('$2')).toBe(true);
      expect(corpo.recoveryCodes).not.toContain(guardado);
    }
    expect(await bcrypt.compare(corpo.recoveryCodes[0], gravado.recoveryCodes[0]!)).toBe(true);
  });

  it('código errado dá 401 e NÃO habilita', async () => {
    usuarioDb.findUnique.mockResolvedValue(usuario({ totpEnabled: false }));

    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/verify', payload: { code: '000000' },
    });

    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('INVALID_2FA_CODE');
    expect(usuarioDb.update).not.toHaveBeenCalled();
  });

  it('sem rodar o setup antes dá 400', async () => {
    usuarioDb.findUnique.mockResolvedValue(usuario({ totpSecret: null }));
    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/verify', payload: { code: '123456' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('2FA_NOT_SETUP');
  });

  it('sem code no corpo dá 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: {} });
    expect(r.statusCode).toBe(400);
  });
});

describe('POST /auth/2fa/validate — o portão do login', () => {
  function tempToken(over: Record<string, unknown> = {}) {
    return app.jwt.sign({ sub: 'u1', email: 'a@ex.com', pending2fa: true, ...over });
  }

  it('código válido emite o JWT de sessão', async () => {
    usuarioDb.findUnique.mockResolvedValue(usuario());

    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/validate',
      payload: { tempToken: tempToken(), code: codigoValido(segredo) },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().token).toBeTruthy();
    expect(r.json().user.email).toBe('a@ex.com');
  });

  it('código errado NÃO emite token', async () => {
    usuarioDb.findUnique.mockResolvedValue(usuario());

    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/validate',
      payload: { tempToken: tempToken(), code: '000000' },
    });

    expect(r.statusCode).toBe(401);
    expect(r.json().token).toBeUndefined();
  });

  it('token SEM pending2fa é recusado — senão qualquer JWT viraria bypass do 2FA', async () => {
    // Esta é a regressão mais perigosa do arquivo: se o `pending2fa` deixasse
    // de ser checado, um token de sessão comum (ou de outro fluxo) serviria
    // para pular o segundo fator.
    usuarioDb.findUnique.mockResolvedValue(usuario());

    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/validate',
      payload: { tempToken: app.jwt.sign({ sub: 'u1', email: 'a@ex.com' }), code: codigoValido(segredo) },
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('INVALID_TOKEN');
    expect(r.json().token).toBeUndefined();
  });

  it('token assinado com outro segredo dá 401', async () => {
    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/validate',
      payload: { tempToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.falsa', code: '123456' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('INVALID_TOKEN');
  });

  it('faltando tempToken ou code dá 400', async () => {
    const semCode = await app.inject({
      method: 'POST', url: '/auth/2fa/validate', payload: { tempToken: tempToken() },
    });
    expect(semCode.statusCode).toBe(400);

    const semToken = await app.inject({
      method: 'POST', url: '/auth/2fa/validate', payload: { code: '123456' },
    });
    expect(semToken.statusCode).toBe(400);
  });
});

describe('código de recuperação — uso único', () => {
  it('aceita o código de recuperação e o REMOVE da lista', async () => {
    const recuperacao = 'a1b2c3d4';
    const outro = 'ffffffff';
    usuarioDb.findUnique.mockResolvedValue(usuario({
      recoveryCodes: [await bcrypt.hash(outro, 4), await bcrypt.hash(recuperacao, 4)],
    }));

    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/validate',
      payload: {
        tempToken: app.jwt.sign({ sub: 'u1', email: 'a@ex.com', pending2fa: true }),
        code: recuperacao, // não é TOTP: só passa pela via de recuperação
      },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().token).toBeTruthy();

    // Uso único: sobra apenas o outro código. Se a lista voltasse inteira, o
    // mesmo código serviria para sempre.
    const restantes = argDaChamada<{ data: { recoveryCodes: string[] } }>(usuarioDb.update).data.recoveryCodes;
    expect(restantes).toHaveLength(1);
    expect(await bcrypt.compare(outro, restantes[0]!)).toBe(true);
    expect(await bcrypt.compare(recuperacao, restantes[0]!)).toBe(false);
  });

  it('código de recuperação inexistente dá 401', async () => {
    usuarioDb.findUnique.mockResolvedValue(usuario({
      recoveryCodes: [await bcrypt.hash('outro-codigo', 4)],
    }));

    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/validate',
      payload: {
        tempToken: app.jwt.sign({ sub: 'u1', email: 'a@ex.com', pending2fa: true }),
        code: 'nao-existe',
      },
    });

    expect(r.statusCode).toBe(401);
    expect(usuarioDb.update).not.toHaveBeenCalled();
  });
});

describe('POST /auth/2fa/disable', () => {
  it('com a senha certa, desliga e limpa segredo e códigos', async () => {
    usuarioDb.findUnique.mockResolvedValue(usuario());

    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/disable', payload: { password: 'senha-correta' },
    });

    expect(r.statusCode).toBe(200);
    const gravado = argDaChamada<{ data: Record<string, unknown> }>(usuarioDb.update).data;
    expect(gravado.totpEnabled).toBe(false);
    // O segredo tem que sumir: mantê-lo permitiria religar sem novo setup.
    expect(gravado.totpSecret).toBeNull();
    expect(gravado.recoveryCodes).toEqual([]);
  });

  it('senha errada NÃO desliga — sessão roubada não derruba o 2FA sozinha', async () => {
    usuarioDb.findUnique.mockResolvedValue(usuario());

    const r = await app.inject({
      method: 'POST', url: '/auth/2fa/disable', payload: { password: 'senha-errada' },
    });

    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('INVALID_PASSWORD');
    expect(usuarioDb.update).not.toHaveBeenCalled();
  });

  it('sem senha no corpo dá 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/2fa/disable', payload: {} });
    expect(r.statusCode).toBe(400);
    expect(usuarioDb.update).not.toHaveBeenCalled();
  });
});
