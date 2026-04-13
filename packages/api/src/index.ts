import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { env } from './config/env.js';
import { AppError } from './lib/errors.js';
import { sheetsRoutes } from './routes/v1/sheets.js';
import { authRoutes } from './routes/auth.js';
import { dashboardApiRoutes } from './routes/dashboard/apis.js';
import { registerUsageLogger } from './middleware/usage-logger.js';

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
  },
});

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
