import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rawBody from 'fastify-raw-body';
import { env } from './config/env.js';
import { AppError } from './lib/errors.js';
import { sheetsRoutes } from './routes/v1/sheets.js';
import { authRoutes } from './routes/auth.js';
import { dashboardApiRoutes } from './routes/dashboard/apis.js';
import { registerUsageLogger } from './middleware/usage-logger.js';
import { registerRateLimiter } from './middleware/rate-limiter.js';
import redisPlugin from './plugins/redis.js';
import { initCache } from './services/cache.service.js';
import { initSheetsWriteQueue } from './queues/sheets-write.queue.js';
import { initSheetsWriteWorker, closeSheetsWriteWorker } from './workers/sheets-write.worker.js';
import { initWebhookDeliveryQueue } from './queues/webhook-delivery.queue.js';
import { initWebhookDeliveryWorker, closeWebhookDeliveryWorker } from './workers/webhook-delivery.worker.js';
import { importExportRoutes } from './routes/v1/import-export.js';
import { webhookRoutes } from './routes/dashboard/webhooks.js';
import { auth2faRoutes } from './routes/auth-2fa.js';
import { logsStreamRoutes } from './routes/dashboard/logs-stream.js';
import { flushAuditLog } from './services/audit.service.js';
import { flushUsageLog } from './services/usage.service.js';
import { computedFieldRoutes } from './routes/dashboard/computed-fields.js';
import { snapshotRoutes } from './routes/dashboard/snapshots.js';
import { scheduledSyncRoutes } from './routes/dashboard/scheduled-sync.js';
import { multiSpreadsheetRoutes } from './routes/dashboard/multi-spreadsheet.js';
import { initScheduledSyncQueue, updateSyncSchedule } from './queues/scheduled-sync.queue.js';
import { initScheduledSyncWorker, closeScheduledSyncWorker } from './workers/scheduled-sync.worker.js';
import { schemaRoutes } from './routes/v1/schema.js';
import { prisma } from './lib/prisma.js';

const app = Fastify({
  logger: { level: env.LOG_LEVEL },
  bodyLimit: env.BODY_LIMIT,
  trustProxy: true,
  // Echo `X-Request-Id` so support flows can correlate logs ↔ client reports.
  requestIdHeader: 'x-request-id',
  genReqId: (req) => (req.headers['x-request-id'] as string) || `req_${Math.random().toString(36).slice(2, 12)}`,
});

// Capture raw request bytes so the HMAC middleware (X-Signature-Version: 2)
// can sign the exact payload the client sent — independent of how Fastify's
// JSON parser re-serializes the object. Required for cross-language signing
// (Go/Python clients otherwise fail v1's JSON.stringify-based canonical).
// `global: true` populates request.rawBody on every route; cap is bodyLimit.
app.register(rawBody, {
  field: 'rawBody',
  global: true,
  encoding: 'utf8',
  runFirst: true,
});

// Redis plugin
app.register(redisPlugin);

// Security headers (relaxed CSP since frontend is separate)
app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});

// Global CORS for dashboard/auth routes (sheet routes handle CORS per-API).
// Allowlist comes from env.ALLOWED_ORIGINS (comma-separated). Falls back to
// FRONTEND_URL. Reflecting any origin with credentials enabled is a CSRF foot-
// gun — kept strict here.
const corsOrigins = env.ALLOWED_ORIGINS
  ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [env.FRONTEND_URL];
app.register(cors, {
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
  credentials: true,
});

// OpenAPI / Swagger
app.register(swagger, {
  openapi: {
    info: {
      title: 'sheets.banco API',
      description: 'Turn Google Sheets into REST APIs',
      version: '1.0.0',
    },
    servers: [{ url: `http://${env.HOST}:${env.PORT}` }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        basicAuth: { type: 'http', scheme: 'basic' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      },
    },
  },
});
app.register(swaggerUi, { routePrefix: '/docs' });

// Rate limiter (registered globally, applied per-route)
registerRateLimiter(app);

// JWT plugin
app.register(fastifyJwt, {
  secret: env.JWT_SECRET,
  sign: { expiresIn: '24h' },
});

// Global error handler. Echoes `request_id` on every error response so support
// can correlate client-reported failures with server logs.
app.setErrorHandler((error: Error, request, reply) => {
  const requestId = request.id;
  reply.header('X-Request-Id', requestId);

  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: true,
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      request_id: requestId,
      ...(error.details && { details: error.details }),
    });
  }

  const fastifyError = error as Error & { validation?: unknown; code?: string; statusCode?: number };

  // Rate limit errors
  if (fastifyError.statusCode === 429) {
    return reply.status(429).send({
      error: true,
      message: 'Too many requests. Please slow down.',
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
      request_id: requestId,
    });
  }

  // Fastify validation errors
  if (fastifyError.validation) {
    return reply.status(400).send({
      error: true,
      message: error.message,
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      request_id: requestId,
    });
  }

  // Other Fastify errors with a 4xx statusCode (content-type, payload, etc.) —
  // preserve their original status code instead of masking everything as 500.
  if (
    typeof fastifyError.statusCode === 'number' &&
    fastifyError.statusCode >= 400 &&
    fastifyError.statusCode < 500
  ) {
    return reply.status(fastifyError.statusCode).send({
      error: true,
      message: error.message,
      code: fastifyError.code ?? 'CLIENT_ERROR',
      statusCode: fastifyError.statusCode,
      request_id: requestId,
    });
  }

  app.log.error({ err: error, request_id: requestId }, 'Unhandled error');
  return reply.status(500).send({
    error: true,
    message: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
    request_id: requestId,
  });
});

// Usage logger for sheet API routes
registerUsageLogger(app);

// Routes
// Rate-limiting is registered inside each route file's exported function
// (auth*.ts: 10/min per IP; dashboard/*.ts: 60/min per user) so CodeQL can
// statically verify the protection. /api/v1/* follows the same pattern.
app.register(authRoutes, { prefix: '/auth' });
app.register(auth2faRoutes, { prefix: '/auth' });
app.register(dashboardApiRoutes, { prefix: '/dashboard/apis' });
app.register(webhookRoutes, { prefix: '/dashboard/apis' });
app.register(logsStreamRoutes, { prefix: '/dashboard/apis' });
app.register(computedFieldRoutes, { prefix: '/dashboard/apis' });
app.register(snapshotRoutes, { prefix: '/dashboard/apis' });
app.register(scheduledSyncRoutes, { prefix: '/dashboard/apis' });
app.register(multiSpreadsheetRoutes, { prefix: '/dashboard/apis' });
app.register(sheetsRoutes, { prefix: '/api/v1' });
app.register(importExportRoutes, { prefix: '/api/v1' });
app.register(schemaRoutes, { prefix: '/api/v1' });

// Health check
app.get('/health', async () => ({ status: 'ok' }));

// Graceful shutdown
app.addHook('onClose', async () => {
  await flushAuditLog();
  await flushUsageLog();
  await closeSheetsWriteWorker();
  await closeWebhookDeliveryWorker();
  await closeScheduledSyncWorker();
});

// Start
const start = async () => {
  try {
    await app.ready();

    // Initialize Redis-backed cache after plugin is registered
    initCache(app.redis);

    // BullMQ requires a real Redis instance. Skip when running without one
    // (REDIS_URL not set in env) — write/sync features become unavailable but
    // reads stay fast instead of burning seconds per request on retries.
    const hasRedis = !!app.redis;
    if (hasRedis) {
      initSheetsWriteQueue(env.REDIS_URL);
      initSheetsWriteWorker(env.REDIS_URL);
      initWebhookDeliveryQueue(env.REDIS_URL);
      initWebhookDeliveryWorker(env.REDIS_URL);
      initScheduledSyncQueue(env.REDIS_URL);
      initScheduledSyncWorker(env.REDIS_URL);
      app.log.info('BullMQ queues and workers started');
    } else {
      app.log.warn('Skipping BullMQ initialization — Redis not configured (writes/webhooks/scheduled-sync disabled)');
    }

    // Restore scheduled sync jobs from database
    const syncApis = await prisma.sheetApi.findMany({
      where: { syncEnabled: true, syncCron: { not: null } },
      select: { id: true, syncCron: true, userId: true, spreadsheetId: true },
    });
    for (const api of syncApis) {
      if (api.syncCron && api.userId) {
        await updateSyncSchedule(api.id, api.syncCron, api.userId, api.spreadsheetId);
      }
    }
    if (syncApis.length > 0) app.log.info(`Restored ${syncApis.length} scheduled sync jobs`);

    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`sheets.banco API running on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
};

start();
