/**
 * Testes de `middleware/jwt-auth.ts` — o portão de todo `/dashboard/*`.
 *
 * Este arquivo não existia, e a ausência dele tem nome: `auth-2fa.test.ts:33`
 * **mocka** o `jwtAuth`. Com o portão substituído por um dublê em todo lugar
 * que o exercitava, nada olhava o que ele de fato aceitava — e o que ele
 * aceitava era qualquer JWT assinado com o `JWT_SECRET`, incluindo o token
 * intermediário do 2FA.
 *
 * Aqui o middleware é o **real**, sobre o plugin `@fastify/jwt` real. O caso
 * que dá nome ao arquivo é o `ACHADO`, mais abaixo.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { montarApp, bearerDe, JWT_SECRET } from '../test-utils/app.js';
import { jwtAuth } from './jwt-auth.js';
import { JWT_PURPOSE } from '../lib/jwt-purpose.js';

/** Rota mínima cujo único propósito é estar atrás do `jwtAuth`. */
async function rotaProtegida(app: FastifyInstance) {
  app.get('/protegida', { preHandler: [jwtAuth] }, async (request) => {
    const { sub } = request.user as { sub: string };
    return { ok: true, sub };
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  app = await montarApp({ rotas: rotaProtegida });
});

function pedir(authorization?: string) {
  return app.inject({
    method: 'GET',
    url: '/protegida',
    headers: authorization ? { authorization } : {},
  });
}

describe('jwtAuth — quem entra', () => {
  it('aceita token de sessão', async () => {
    const res = await pedir(
      bearerDe(app, { sub: 'u1', email: 'a@ex.com', purpose: JWT_PURPOSE.SESSION }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sub: 'u1' });
  });

  it('aceita token sem `purpose` — os que já estavam em circulação no deploy', async () => {
    // Compatibilidade deliberada: exigir o claim aqui deslogaria todo mundo no
    // merge, em vez de na rotação do segredo. Não reabre a falha, porque o
    // token do 2FA é barrado pelo `pending2fa`, que ele sempre carregou.
    const res = await pedir(bearerDe(app, { sub: 'u1', email: 'a@ex.com' }));

    expect(res.statusCode).toBe(200);
  });
});

describe('jwtAuth — o bypass de 2FA', () => {
  it('ACHADO: recusa o tempToken do 2FA, que antes valia como sessão', async () => {
    // Este é EXATAMENTE o payload que `routes/auth.ts` assina quando a conta
    // tem TOTP e o código ainda não foi conferido. Ele prova apenas a senha.
    //
    // Antes do `purpose`, o `jwtAuth` só chamava `jwtVerify()`: assinatura boa,
    // dentro da validade, entrava. Quem tivesse a senha de uma conta com 2FA
    // pegava este token na resposta do `/auth/login` e o usava como Bearer em
    // todo `/dashboard/*` por cinco minutos — sem nunca digitar o TOTP. Tempo
    // de sobra para emitir uma ApiKey permanente via `POST /:id/keys`.
    const tempToken = bearerDe(app, {
      sub: 'u1',
      email: 'a@ex.com',
      pending2fa: true,
      purpose: JWT_PURPOSE.PENDING_2FA,
    });

    const res = await pedir(tempToken);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: true, code: 'TOKEN_WRONG_PURPOSE' });
  });

  it('recusa pelo `pending2fa` mesmo sem o claim `purpose`', async () => {
    // O token de 2FA emitido ANTES deste deploy não tem `purpose`. Se a regra
    // dependesse só dele, esses tokens continuariam servindo de bypass durante
    // toda a janela de cinco minutos após o merge.
    const res = await pedir(bearerDe(app, { sub: 'u1', email: 'a@ex.com', pending2fa: true }));

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'TOKEN_WRONG_PURPOSE' });
  });

  it('recusa propósito desconhecido — a lista é de permissão, não de bloqueio', async () => {
    // Importa que a regra seja "só `session` passa" e não "`2fa_pending` não
    // passa": um propósito futuro criado sem tocar no `jwtAuth` precisa nascer
    // recusado, não aceito.
    const res = await pedir(bearerDe(app, { sub: 'u1', email: 'a@ex.com', purpose: 'inventado' }));

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'TOKEN_WRONG_PURPOSE' });
  });
});

describe('jwtAuth — token ausente ou inválido', () => {
  it('sem header Authorization dá 401 UNAUTHORIZED', async () => {
    const res = await pedir();

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('com assinatura adulterada dá 401 UNAUTHORIZED', async () => {
    // Payload legítimo, assinatura corrompida: é o que chega quando alguém
    // edita os claims sem ter o segredo.
    const valido = app.jwt.sign({ sub: 'u1', email: 'a@ex.com' });
    const adulterado = `${valido.slice(0, -4)}xxxx`;

    const res = await pedir(`Bearer ${adulterado}`);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('expirado dá 401 UNAUTHORIZED', async () => {
    const vencido = app.jwt.sign(
      { sub: 'u1', email: 'a@ex.com', purpose: JWT_PURPOSE.SESSION },
      { expiresIn: '-1s' },
    );

    const res = await pedir(`Bearer ${vencido}`);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('distingue "não autenticado" de "token de outro propósito"', async () => {
    // Os dois são 401, mas o código precisa diferir: um relato de suporte com
    // TOKEN_WRONG_PURPOSE aponta para um cliente mandando o token errado, e não
    // para credencial vencida. Confundir os dois manda o suporte para o lado
    // errado da investigação.
    const semToken = await pedir();
    const propositoErrado = await pedir(bearerDe(app, { sub: 'u1', pending2fa: true }));

    expect(semToken.json().code).toBe('UNAUTHORIZED');
    expect(propositoErrado.json().code).toBe('TOKEN_WRONG_PURPOSE');
    expect(semToken.json().code).not.toBe(propositoErrado.json().code);
  });

  it('a recusa por propósito carrega request_id, como todo erro da casa', async () => {
    const res = await pedir(bearerDe(app, { sub: 'u1', pending2fa: true }));

    expect(res.json().request_id).toBeTruthy();
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('JWT_SECRET de teste', () => {
  it('tem o tamanho que o env exige em produção', () => {
    // Guarda contra alguém encurtar o segredo do test-utils e mascarar uma
    // regressão na validação de `config/env.ts` (mínimo de 32 em produção).
    expect(JWT_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});
