import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

/**
 * Handler de erro da aplicação, em módulo próprio.
 *
 * Antes ele vivia inline no `index.ts` e era **copiado à mão** dentro de
 * `test-utils/app.ts`, porque importar o `index.ts` num teste puxaria Redis,
 * Postgres, filas e workers na importação. A cópia foi aceita na época em
 * troca de teste rápido, com o custo declarado de que "se mudar lá, tem que
 * mudar aqui" — exatamente o tipo de acordo que ninguém lembra de honrar seis
 * meses depois. Com o handler aqui, os dois lados usam o mesmo código e a
 * divergência silenciosa deixa de ser possível.
 *
 * Toda resposta de erro leva o `request_id`, ecoado também no header
 * `X-Request-Id`, para correlacionar relato de cliente com log de servidor
 * (ver `docs/error-handling.md`).
 */
/**
 * Garante `request_id` em TODA resposta de erro, inclusive nas que não passam
 * pelo `setErrorHandler`.
 *
 * O handler acima só vê o que é **lançado**. Mas 31 pontos espalhados por 10
 * arquivos — os middlewares de auth/cors/ip/hmac e várias rotas — respondem
 * com `reply.status(n).send({ error: true, ... })` direto, sem lançar. Essas
 * respostas saíam sem `request_id` e sem o header `X-Request-Id`, contrariando
 * a primeira linha de `docs/error-handling.md`.
 *
 * Um hook em vez de 31 edições: além de ser um lugar só, ele cobre o próximo
 * `reply.send` de erro que alguém escrever. Editar os 31 sites resolveria hoje
 * e voltaria a divergir no primeiro que fosse esquecido.
 *
 * `preSerialization` (não `onSend`) para trabalhar com o OBJETO, antes de
 * virar string — assim não há parse nem re-serialização. O hook não roda para
 * payload que já é string ou buffer, o que também evita mexer em CSV, XLSX e
 * no stream de SSE.
 */
export function registerRequestIdOnErrors(app: FastifyInstance) {
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (reply.statusCode < 400) return payload;
    if (!payload || typeof payload !== 'object') return payload;

    const corpo = payload as Record<string, unknown>;
    // `error: true` é a marca do envelope da casa. Resposta de erro que não o
    // usa (nenhuma hoje) fica intocada de propósito.
    if (corpo.error !== true || corpo.request_id) return payload;

    reply.header('X-Request-Id', request.id);
    return { ...corpo, request_id: request.id };
  });
}

/**
 * Handler de rota não encontrada.
 *
 * Precisa ser registrado à parte porque o Fastify **não** manda o 404 de rota
 * desconhecida para o `setErrorHandler` — ele tem um caminho próprio. Sem
 * este registro, o embutido do framework responde
 *
 *     {"message":"Route GET:/x not found","error":"Not Found","statusCode":404}
 *
 * sem `error: true`, sem `code`, sem `request_id` e sem o header
 * `X-Request-Id`. Ou seja: quem erra a URL recebia um erro de formato
 * diferente de todos os outros e sem id para correlacionar com o log,
 * contrariando o que `docs/error-handling.md` promete para toda resposta de
 * erro. O 404 de "API não encontrada" sempre saiu certo, porque é um
 * `AppError` e passa pelo handler acima — a divergência atingia só quem
 * digitou o caminho errado.
 */
export function registerNotFoundHandler(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => {
    const requestId = request.id;
    reply.header('X-Request-Id', requestId);

    return reply.status(404).send({
      error: true,
      message: `Route ${request.method}:${request.url} not found`,
      code: 'ROUTE_NOT_FOUND',
      statusCode: 404,
      request_id: requestId,
    });
  });
}

export function registerErrorHandler(app: FastifyInstance) {
  // `error: Error` anotado explicitamente: nesta versão do Fastify o TS infere
  // `unknown` para o parâmetro e nada abaixo compila.
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

    // Rate limit
    if (fastifyError.statusCode === 429) {
      return reply.status(429).send({
        error: true,
        message: 'Too many requests. Please slow down.',
        code: 'RATE_LIMIT_EXCEEDED',
        statusCode: 429,
        request_id: requestId,
      });
    }

    // Erros de validação do Fastify
    if (fastifyError.validation) {
      return reply.status(400).send({
        error: true,
        message: error.message,
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        request_id: requestId,
      });
    }

    // Demais erros 4xx do Fastify (content-type, payload, etc.) — preserva o
    // status original em vez de mascarar tudo como 500.
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
}
