/**
 * Monta uma instância mínima do Fastify para testar rotas de verdade.
 *
 * O `app.inject()` do Fastify executa o ciclo completo — hooks, validação,
 * serialização, error handler — sem abrir porta nem fazer I/O de rede. É o que
 * permite testar as rotas (hoje com 0% de cobertura) sem subir a stack toda.
 *
 * O que NÃO entra aqui de propósito: Redis, BullMQ, workers e os plugins de
 * infraestrutura. Cada teste registra só a rota que exercita, mais o error
 * handler real do `index.ts`, que é o que traduz AppError → resposta JSON. Se
 * o teste importasse `index.ts` inteiro ele tentaria conectar em Redis/Postgres
 * na importação e deixaria de ser teste unitário.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { AppError } from '../lib/errors.js';

/**
 * Lê o argumento de uma chamada de mock com segurança de tipo.
 *
 * `mock.calls[0][0]` é `possibly undefined` sob `noUncheckedIndexedAccess`
 * (ligado neste projeto desde o PR #63). Em vez de espalhar `!` pelos testes,
 * esta função falha com uma mensagem útil quando a chamada não aconteceu —
 * que é justamente o que se quer saber quando um teste quebra.
 */
export function argDaChamada<T = Record<string, unknown>>(
  mock: { mock: { calls: unknown[][] } },
  chamada = 0,
  posicao = 0,
): T {
  const args = mock.mock.calls[chamada];
  if (!args) {
    throw new Error(`Esperava ao menos ${chamada + 1} chamada(s), houve ${mock.mock.calls.length}.`);
  }
  return args[posicao] as T;
}

export const JWT_SECRET = 'segredo-de-teste-com-tamanho-suficiente-1234567890';

interface Opts {
  /** Plugin de rotas a registrar (ex.: `authRoutes`). */
  rotas: (app: FastifyInstance) => Promise<void>;
  /** Prefixo, espelhando o que o index.ts usa (ex.: '/auth'). */
  prefixo?: string;
}

/**
 * Réplica do error handler de `index.ts`. Duplicado de propósito: importar o
 * `index.ts` aqui puxaria Redis, filas e workers. O acoplamento é aceito em
 * troca de o teste rodar em milissegundos — mas se o handler lá mudar, este
 * precisa mudar junto.
 */
function registrarErrorHandler(app: FastifyInstance) {
  // `error: Error` explícito espelha o index.ts. Sem a anotação o TS infere
  // `unknown` nesta versão do Fastify e nada abaixo compila.
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
      });
    }

    const err = error as FastifyError & { validation?: unknown };

    if (err.statusCode === 429) {
      return reply.status(429).send({
        error: true,
        message: 'Too many requests. Please slow down.',
        code: 'RATE_LIMIT_EXCEEDED',
        statusCode: 429,
        request_id: requestId,
      });
    }

    if (err.validation) {
      return reply.status(400).send({
        error: true,
        message: error.message,
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        request_id: requestId,
      });
    }

    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({
        error: true,
        message: error.message,
        code: err.code ?? 'CLIENT_ERROR',
        statusCode: err.statusCode,
        request_id: requestId,
      });
    }

    return reply.status(500).send({
      error: true,
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
      statusCode: 500,
      request_id: requestId,
    });
  });
}

export async function montarApp({ rotas, prefixo }: Opts): Promise<FastifyInstance> {
  // `logger: false` mantém a saída do teste limpa; um erro esperado (401, 409)
  // não deve poluir o terminal com stack trace.
  const app = Fastify({ logger: false });

  await app.register(fastifyJwt, { secret: JWT_SECRET, sign: { expiresIn: '24h' } });
  registrarErrorHandler(app);
  await app.register(rotas, prefixo ? { prefix: prefixo } : {});
  await app.ready();

  return app;
}

/** Gera um Bearer válido para rotas protegidas por `jwtAuth`. */
export function bearerDe(app: FastifyInstance, payload: Record<string, unknown>): string {
  return `Bearer ${app.jwt.sign(payload)}`;
}
