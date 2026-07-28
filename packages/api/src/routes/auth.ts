import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';
import { jwtAuth } from '../middleware/jwt-auth.js';
import { authRateLimitOptions } from '../middleware/rate-limiter.js';
import { env } from '../config/env.js';
import { encryptOptional } from '../lib/secret-cipher.js';
import { JWT_PURPOSE, ehTokenDeSessao } from '../lib/jwt-purpose.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

function createOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/spreadsheets',
];

/**
 * Monta a URL da tela de consentimento do Google.
 *
 * `login` é para quem ainda não tem sessão; `connect` liga a conta Google a um
 * usuário que já entrou, e por isso carrega o `userId` no `state`.
 */
function urlDeConsentimento(state: { mode: 'login' } | { mode: 'connect'; userId: string }) {
  return createOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    prompt: state.mode === 'login' ? 'select_account' : 'consent',
    scope: GOOGLE_SCOPES,
    state: JSON.stringify(state),
  });
}

export async function authRoutes(app: FastifyInstance) {
  // Strict per-IP rate limit applied to every route below — defends
  // login/register/2FA from brute force.
  //
  // O `await` NÃO é enfeite, e a ausência dele deixou este limite morto desde
  // que foi escrito. Sem ele o `register` só entra na fila: o plugin instala o
  // hook `onRequest` depois que as rotas deste escopo já foram vinculadas, e o
  // hook não as alcança. O efeito é silencioso — a chamada existe, o comentário
  // promete, e passam mil requisições por minuto.
  //
  // Foi o CodeQL (`js/missing-rate-limiting`, alerta #61) que apontou, e a
  // primeira leitura aqui foi tratá-lo como falso positivo. Um teste com o
  // plugin real mostrou que ele estava certo. Ver `rate-limiter.test.ts`, que
  // varre os arquivos de rota atrás deste padrão.
  await app.register(import('@fastify/rate-limit'), authRateLimitOptions() as any);

  // POST /auth/register
  app.post('/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid email or password (min 6 characters).');
    }

    const { email, password, name } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.status(409).send({
        error: true,
        message: 'Email already registered.',
        code: 'EMAIL_EXISTS',
        statusCode: 409,
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, passwordHash, name },
    });

    const token = app.jwt.sign({
      sub: user.id,
      email: user.email,
      purpose: JWT_PURPOSE.SESSION,
    });

    return reply.status(201).send({
      user: { id: user.id, email: user.email, name: user.name, googleConnected: false },
      token,
    });
  });

  // POST /auth/login
  app.post('/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid email or password.');
    }

    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return reply.status(401).send({
        error: true,
        message: 'Invalid email or password.',
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({
        error: true,
        message: 'Invalid email or password.',
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });
    }

    // If 2FA is enabled, return a temp token requiring verification.
    //
    // Este token prova APENAS a senha. O `purpose` é o que impede o `jwtAuth`
    // de aceitá-lo como sessão — sem ele, quem tivesse a senha atravessava o
    // segundo fator usando esta própria resposta como credencial.
    if (user.totpEnabled) {
      const tempToken = app.jwt.sign(
        {
          sub: user.id,
          email: user.email,
          pending2fa: true,
          purpose: JWT_PURPOSE.PENDING_2FA,
        },
        { expiresIn: '5m' },
      );
      return { requires2FA: true, tempToken };
    }

    const token = app.jwt.sign({
      sub: user.id,
      email: user.email,
      purpose: JWT_PURPOSE.SESSION,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        googleConnected: !!user.googleRefreshToken,
      },
      token,
    };
  });

  // GET /auth/me
  app.get('/me', { preHandler: [jwtAuth] }, async (request) => {
    const { sub } = request.user as { sub: string };
    const user = await prisma.user.findUnique({
      where: { id: sub },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        googleRefreshToken: true,
      },
    });

    if (!user) return { user: null };

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
        googleConnected: !!user.googleRefreshToken,
      },
    };
  });

  // POST /auth/google/url — devolve a URL de consentimento para o fluxo
  // "conectar Google a esta conta".
  //
  // Existe para tirar o JWT da barra de endereço. O `GET` abaixo recebia o
  // token de sessão em `?token=`, porque `window.location.href` é navegação de
  // topo e não aceita header — e uma URL com segredo entra no histórico do
  // navegador, no `Referer` e no log de acesso de todo intermediário.
  //
  // Aqui o token vai no header, como em qualquer outra chamada autenticada, e
  // o navegador só é mandado para a URL do Google, que não carrega segredo
  // nosso.
  app.post('/google/url', { preHandler: [jwtAuth] }, async (request) => {
    const { sub } = request.user as { sub: string };
    return { url: urlDeConsentimento({ mode: 'connect', userId: sub }) };
  });

  // GET /auth/google — redirect to Google consent screen
  // mode=login: sign in/up with Google (no existing account needed)
  // mode=connect: link Google to existing account (needs JWT token param)
  //
  // O ramo `connect` (com `?token=`) está DEPRECADO em favor do
  // `POST /auth/google/url`. Continua aqui porque a API (Render) e o dashboard
  // (Vercel) sobem em deploys independentes a partir do mesmo merge: derrubar
  // o contrato antigo junto com a mudança do front quebraria "conectar Google"
  // na janela entre os dois. Pode sair num release seguinte.
  //
  // O ramo `login` não tem esse problema — não recebe token nenhum.
  app.get('/google', async (request, reply) => {
    const { token, mode } = request.query as { token?: string; mode?: string };

    // Login/register with Google (no account needed)
    if (mode === 'login' || !token) {
      return reply.redirect(urlDeConsentimento({ mode: 'login' }));
    }

    // Connect Google to existing account
    let sub: string;
    try {
      const decoded = app.jwt.verify<{ sub: string; purpose?: string }>(token);
      // Mesma regra do `jwtAuth`: token de etapa intermediária não vale como
      // sessão. Sem isto, o `tempToken` do 2FA ligaria uma conta Google sem
      // que o segundo fator tivesse sido conferido.
      if (!ehTokenDeSessao(decoded)) throw new Error('propósito inválido');
      sub = decoded.sub;
    } catch {
      return reply.status(401).send({ error: true, message: 'Invalid token.', code: 'UNAUTHORIZED', statusCode: 401 });
    }

    return reply.redirect(urlDeConsentimento({ mode: 'connect', userId: sub }));
  });

  // POST /auth/google/exchange — troca o código de uso curto por uma sessão.
  //
  // O callback do OAuth só consegue devolver algo ao navegador pela URL do
  // redirect, e antes o que ia ali era o JWT de sessão de 24h — que fica no
  // histórico do navegador e no log de acesso da Vercel para sempre. Agora vai
  // um código de 60 segundos, trocado aqui por POST.
  //
  // Ele NÃO é de uso único: guardar estado exigiria tabela nova ou depender do
  // Redis para o login funcionar. A defesa é a validade curtíssima somada ao
  // propósito — reapresentar o código depois de um minuto não vale nada, e
  // dentro do minuto ele já foi usado pela aba que o recebeu.
  app.post('/google/exchange', async (request, reply) => {
    const { code } = (request.body ?? {}) as { code?: string };
    if (!code) throw new ValidationError('Provide "code".');

    let payload: { sub: string; email: string; purpose?: string };
    try {
      payload = app.jwt.verify<typeof payload>(code);
    } catch {
      return reply.status(401).send({
        error: true,
        message: 'Invalid or expired code.',
        code: 'INVALID_EXCHANGE_CODE',
        statusCode: 401,
      });
    }

    if (payload.purpose !== JWT_PURPOSE.OAUTH_EXCHANGE) {
      return reply.status(401).send({
        error: true,
        message: 'Invalid or expired code.',
        code: 'INVALID_EXCHANGE_CODE',
        statusCode: 401,
      });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return reply.status(401).send({
        error: true,
        message: 'Invalid or expired code.',
        code: 'INVALID_EXCHANGE_CODE',
        statusCode: 401,
      });
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        googleConnected: !!user.googleRefreshToken,
      },
      token: app.jwt.sign({
        sub: user.id,
        email: user.email,
        purpose: JWT_PURPOSE.SESSION,
      }),
    };
  });

  // GET /auth/google/callback — handle Google OAuth callback
  app.get('/google/callback', async (request, reply) => {
    const { code, state: stateRaw } = request.query as { code?: string; state?: string };

    if (!code || !stateRaw) {
      return reply.redirect(`${env.FRONTEND_URL}/login?google=error`);
    }

    let state: { mode: string; userId?: string };
    try {
      state = JSON.parse(stateRaw);
    } catch {
      return reply.redirect(`${env.FRONTEND_URL}/login?google=error`);
    }

    try {
      const oauth2Client = createOAuth2Client();
      const { tokens } = await oauth2Client.getToken(code);

      if (state.mode === 'connect' && state.userId) {
        // Link Google to existing user
        await prisma.user.update({
          where: { id: state.userId },
          data: {
            googleAccessToken: encryptOptional(tokens.access_token),
            googleRefreshToken: encryptOptional(tokens.refresh_token),
            googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
          },
        });
        return reply.redirect(`${env.FRONTEND_URL}/apis?google=connected`);
      }

      // Login/register flow: get user info from Google
      oauth2Client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const { data: profile } = await oauth2.userinfo.get();

      if (!profile.email) {
        return reply.redirect(`${env.FRONTEND_URL}/login?google=error`);
      }

      // Find or create user
      let user = await prisma.user.findUnique({ where: { email: profile.email } });

      if (user) {
        // Update Google tokens
        await prisma.user.update({
          where: { id: user.id },
          data: {
            googleAccessToken: encryptOptional(tokens.access_token),
            googleRefreshToken: encryptOptional(tokens.refresh_token),
            googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
            name: user.name || profile.name || undefined,
          },
        });
      } else {
        // Create new user (random password since they use Google login)
        const randomPass = await bcrypt.hash(crypto.randomUUID(), 4);
        user = await prisma.user.create({
          data: {
            email: profile.email,
            passwordHash: randomPass,
            name: profile.name || null,
            googleAccessToken: encryptOptional(tokens.access_token),
            googleRefreshToken: encryptOptional(tokens.refresh_token),
            googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
          },
        });
      }

      // Código de troca, não sessão. Vai na URL porque redirect não tem outro
      // canal — mas vale 60 segundos, então o endereço que fica no histórico do
      // navegador e no log de acesso da Vercel deixa de servir para qualquer
      // coisa um minuto depois. Antes daqui saía o JWT de sessão de 24h.
      const codigo = app.jwt.sign(
        { sub: user.id, email: user.email, purpose: JWT_PURPOSE.OAUTH_EXCHANGE },
        { expiresIn: '60s' },
      );
      return reply.redirect(`${env.FRONTEND_URL}/callback?code=${codigo}&google=connected`);
    } catch {
      return reply.redirect(`${env.FRONTEND_URL}/login?google=error`);
    }
  });
}
