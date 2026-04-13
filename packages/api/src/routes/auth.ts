import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';
import { jwtAuth } from '../middleware/jwt-auth.js';
import { env } from '../config/env.js';

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

export async function authRoutes(app: FastifyInstance) {
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

    const token = app.jwt.sign({ sub: user.id, email: user.email });

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

    const token = app.jwt.sign({ sub: user.id, email: user.email });

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

  // GET /auth/google — redirect to Google consent screen
  // mode=login: sign in/up with Google (no existing account needed)
  // mode=connect: link Google to existing account (needs JWT token param)
  app.get('/google', async (request, reply) => {
    const { token, mode } = request.query as { token?: string; mode?: string };

    const oauth2Client = createOAuth2Client();
    const scopes = [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/spreadsheets',
    ];

    // Login/register with Google (no account needed)
    if (mode === 'login' || !token) {
      const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: scopes,
        state: JSON.stringify({ mode: 'login' }),
      });
      return reply.redirect(url);
    }

    // Connect Google to existing account
    let sub: string;
    try {
      const decoded = app.jwt.verify<{ sub: string }>(token);
      sub = decoded.sub;
    } catch {
      return reply.status(401).send({ error: true, message: 'Invalid token.', code: 'UNAUTHORIZED', statusCode: 401 });
    }

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state: JSON.stringify({ mode: 'connect', userId: sub }),
    });

    return reply.redirect(url);
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
            googleAccessToken: tokens.access_token ?? undefined,
            googleRefreshToken: tokens.refresh_token ?? undefined,
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
            googleAccessToken: tokens.access_token ?? undefined,
            googleRefreshToken: tokens.refresh_token ?? undefined,
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
            googleAccessToken: tokens.access_token ?? undefined,
            googleRefreshToken: tokens.refresh_token ?? undefined,
            googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
          },
        });
      }

      const jwt = app.jwt.sign({ sub: user.id, email: user.email });
      return reply.redirect(`${env.FRONTEND_URL}/callback?token=${jwt}&google=connected`);
    } catch {
      return reply.redirect(`${env.FRONTEND_URL}/login?google=error`);
    }
  });
}
