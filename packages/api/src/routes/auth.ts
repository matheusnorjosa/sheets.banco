import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';
import { jwtAuth } from '../middleware/jwt-auth.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

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
      user: { id: user.id, email: user.email, name: user.name },
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
      user: { id: user.id, email: user.email, name: user.name },
      token,
    };
  });

  // GET /auth/me
  app.get('/me', { preHandler: [jwtAuth] }, async (request) => {
    const { sub } = request.user as { sub: string };
    const user = await prisma.user.findUnique({
      where: { id: sub },
      select: { id: true, email: true, name: true, createdAt: true },
    });

    return { user };
  });
}
