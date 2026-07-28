import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import rawBody from 'fastify-raw-body';
import { env } from './config/env.js';
import { redactPaths, serializadoresDeLog } from './lib/logger.js';
import {
  registerErrorHandler,
  registerNotFoundHandler,
  registerRequestIdOnErrors,
} from './lib/error-handler.js';
import { sheetsRoutes } from './routes/v1/sheets.js';
import { authRoutes } from './routes/auth.js';
import { dashboardApiRoutes } from './routes/dashboard/apis.js';
import { registerUsageLogger } from './middleware/usage-logger.js';
import { registerRateLimiter } from './middleware/rate-limiter.js';
import redisPlugin from './plugins/redis.js';
import { importExportRoutes } from './routes/v1/import-export.js';
import { webhookRoutes } from './routes/dashboard/webhooks.js';
import { auth2faRoutes } from './routes/auth-2fa.js';
import { logsStreamRoutes } from './routes/dashboard/logs-stream.js';
import { computedFieldRoutes } from './routes/dashboard/computed-fields.js';
import { snapshotRoutes } from './routes/dashboard/snapshots.js';
import { scheduledSyncRoutes } from './routes/dashboard/scheduled-sync.js';
import { multiSpreadsheetRoutes } from './routes/dashboard/multi-spreadsheet.js';
import { schemaRoutes } from './routes/v1/schema.js';

/**
 * Monta a aplicação Fastify — plugins, error handler e rotas — **sem subir
 * servidor, sem abrir conexão e sem iniciar fila**.
 *
 * A separação existe porque o `index.ts` chamava `start()` no topo do módulo:
 * importá-lo, para qualquer fim, abria porta e conectava no Postgres. Isso o
 * tornava impossível de testar (era o único arquivo do pacote que sobrava em
 * 0%) e, pior, impedia que a checagem de import do CI o cobrisse — justamente
 * o arquivo que importa todos os outros.
 *
 * Agora o `index.ts` só orquestra o boot, e tudo que define comportamento HTTP
 * mora aqui, importável em teste.
 *
 * O que continua com efeito colateral na importação: `config/env.ts` valida o
 * ambiente e `lib/prisma.ts` constrói o PrismaClient (sem conectar). Os dois
 * são atravessados pelas rotas de qualquer jeito.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // `serializers` sobrescreve o `req` padrão do Fastify, que registrava a URL
    // com a query inteira — inclusive `?token=<JWT>` em `/auth/google`. O
    // `redact` não alcançava isso: ele redige campo de objeto, e a query é
    // pedaço de string. Ver `lib/logger.ts`.
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: redactPaths, censor: '[REDACTED]' },
      serializers: serializadoresDeLog,
    },
    bodyLimit: env.BODY_LIMIT,
    trustProxy: true,
    // Ecoa `X-Request-Id` para o suporte correlacionar log e relato de cliente.
    requestIdHeader: 'x-request-id',
    genReqId: (req) => (req.headers['x-request-id'] as string) || `req_${Math.random().toString(36).slice(2, 12)}`,
  });

  // Guarda os bytes crus do request para o middleware de HMAC
  // (X-Signature-Version: 2) assinar exatamente o payload que o cliente
  // enviou, independente de como o parser JSON do Fastify o re-serializa.
  // Necessário para assinatura entre linguagens (cliente Go/Python falha com o
  // canônico v1, baseado em JSON.stringify). `global: true` popula
  // `request.rawBody` em toda rota; o teto é o `bodyLimit`.
  app.register(rawBody, {
    field: 'rawBody',
    global: true,
    encoding: 'utf8',
    runFirst: true,
  });

  app.register(redisPlugin);

  // Cabeçalhos de segurança (CSP relaxada porque o frontend é separado)
  app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  // CORS global para as rotas de dashboard/auth (as rotas de planilha tratam
  // CORS por API). A allowlist vem de `env.ALLOWED_ORIGINS`, com fallback para
  // `FRONTEND_URL`. Refletir qualquer origem com `credentials` ligado é um
  // convite a CSRF — por isso a lista é estrita.
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
  // A UI HTML do Swagger (@fastify/swagger-ui) foi removida: ela arrasta
  // @fastify/static <=10.1.1, que tem duas falhas HIGH em aberto (bypass de
  // autorização por caminho não-canônico e path traversal) e NENHUMA correção
  // compatível — o swagger-ui fixa `^9.1.2` e a correção só existe na 10.1.2.
  // Como o /docs era público, era superfície exposta em troca de conveniência.
  //
  // O spec continua sendo gerado pelo @fastify/swagger (que não é afetado) e é
  // servido aqui como JSON puro — sem servir arquivo estático, sem o pacote
  // vulnerável. Quem quer a interface aponta o Swagger Editor/Postman para cá.
  // Os specs POR API (`/api/v1/:apiId/openapi.json` e `/postman.json`) são de
  // código próprio em routes/v1/schema.ts e não dependem disto.
  app.get('/openapi.json', async () => app.swagger());

  // Registrado globalmente, aplicado por rota.
  //
  // O `await` importa: a função é async e no `index.ts` original era chamada
  // sem ele, deixando um `app.register()` em voo enquanto o resto da montagem
  // seguia. Não quebrava o boot porque o `app.ready()` lá embaixo esperava a
  // fila inteira, mas quem chamasse `buildApp()` e registrasse rota logo em
  // seguida caía numa corrida — foi assim que o teste desta montagem travou.
  await registerRateLimiter(app);

  app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: '24h' },
  });

  registerErrorHandler(app);
  registerNotFoundHandler(app);
  registerRequestIdOnErrors(app);

  registerUsageLogger(app);

  // O rate limit é registrado dentro da função exportada por cada arquivo de
  // rota (auth*.ts: 10/min por IP; dashboard/*.ts: 60/min por usuário) para
  // que o CodeQL consiga verificar a proteção estaticamente. /api/v1/* segue
  // o mesmo padrão.
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

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
