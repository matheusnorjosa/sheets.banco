import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { AppError } from './lib/errors.js';
import { sheetsRoutes } from './routes/v1/sheets.js';
import { authRoutes } from './routes/auth.js';
import { dashboardApiRoutes } from './routes/dashboard/apis.js';
import { registerUsageLogger } from './middleware/usage-logger.js';
import { registerRateLimiter } from './middleware/rate-limiter.js';

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
  },
  bodyLimit: 1_048_576, // 1MB
  trustProxy: true,
});

// Security headers (relaxed CSP since frontend is separate)
app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});

// Global CORS for dashboard/auth routes (sheet routes handle CORS per-API)
app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});

// Rate limiter (registered globally, applied per-route)
registerRateLimiter(app);

// JWT plugin
app.register(fastifyJwt, {
  secret: env.JWT_SECRET,
  sign: { expiresIn: '24h' },
});

// Global error handler
app.setErrorHandler((error: Error, request, reply) => {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: true,
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  // Rate limit errors
  if ('statusCode' in error && (error as any).statusCode === 429) {
    return reply.status(429).send({
      error: true,
      message: 'Too many requests. Please slow down.',
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
    });
  }

  // Fastify validation errors
  const fastifyError = error as Error & { validation?: unknown };
  if (fastifyError.validation) {
    return reply.status(400).send({
      error: true,
      message: error.message,
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
  }

  app.log.error(error);
  return reply.status(500).send({
    error: true,
    message: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
});

// Usage logger for sheet API routes
registerUsageLogger(app);

// Routes
app.register(authRoutes, { prefix: '/auth' });
app.register(dashboardApiRoutes, { prefix: '/dashboard/apis' });
app.register(sheetsRoutes, { prefix: '/api/v1' });

// Health check
app.get('/health', async () => ({ status: 'ok' }));

// Start
const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`sheets.banco API running on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
};

start();
