import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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

  // GET /auth/google — redirect user to Google consent screen
  app.get('/google', async (request, reply) => {
    // Accept JWT via query param (browser redirect can't send headers)
    const { token } = request.query as { token?: string };
    if (!token) {
      return reply.status(401).send({ error: true, message: 'Token required.', code: 'UNAUTHORIZED', statusCode: 401 });
    }

    let sub: string;
    try {
      const decoded = app.jwt.verify<{ sub: string }>(token);
      sub = decoded.sub;
    } catch {
      return reply.status(401).send({ error: true, message: 'Invalid token.', code: 'UNAUTHORIZED', statusCode: 401 });
    }

    const oauth2Client = createOAuth2Client();

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/spreadsheets'],
      state: sub, // pass user ID so we know who to link
    });

    return reply.redirect(url);
  });

  // GET /auth/google/callback — handle Google OAuth callback
  app.get('/google/callback', async (request, reply) => {
    const { code, state: userId } = request.query as { code?: string; state?: string };

    if (!code || !userId) {
      return reply.redirect(`${env.FRONTEND_URL}/apis?google=error`);
    }

    try {
      const oauth2Client = createOAuth2Client();
      const { tokens } = await oauth2Client.getToken(code);

      await prisma.user.update({
        where: { id: userId },
        data: {
          googleAccessToken: tokens.access_token ?? undefined,
          googleRefreshToken: tokens.refresh_token ?? undefined,
          googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
        },
      });

      return reply.redirect(`${env.FRONTEND_URL}/apis?google=connected`);
    } catch {
      return reply.redirect(`${env.FRONTEND_URL}/apis?google=error`);
    }
  });
}
