/**
 * Monta uma instância mínima do Fastify para testar rotas de verdade.
 *
 * O `app.inject()` do Fastify executa o ciclo completo — hooks, validação,
 * serialização, error handler — sem abrir porta nem fazer I/O de rede. É o que
 * permite testar rota de verdade sem subir a stack toda.
 *
 * O que NÃO entra aqui de propósito: Redis, BullMQ, workers e os plugins de
 * infraestrutura. Cada teste registra só a rota que exercita, mais o error
 * handler REAL da aplicação (`lib/error-handler.ts`), que traduz AppError em
 * resposta JSON.
 *
 * Para exercitar a aplicação inteira — todos os plugins e todas as rotas —
 * use o `buildApp()` de `src/app.ts`, que também não abre porta. Este helper
 * existe para o caso oposto: isolar UMA rota e deixar o teste em
 * milissegundos.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { registerErrorHandler } from '../lib/error-handler.js';

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

export async function montarApp({ rotas, prefixo }: Opts): Promise<FastifyInstance> {
  // `logger: false` mantém a saída do teste limpa; um erro esperado (401, 409)
  // não deve poluir o terminal com stack trace.
  const app = Fastify({ logger: false });

  await app.register(fastifyJwt, { secret: JWT_SECRET, sign: { expiresIn: '24h' } });
  // O handler REAL, o mesmo que o `app.ts` registra. Antes havia aqui uma
  // cópia manual dele, porque importar o `index.ts` puxaria Redis, filas e
  // workers na importação — o preço era o risco de as duas versões divergirem
  // em silêncio. Extraí-lo para `lib/error-handler.ts` eliminou a escolha.
  registerErrorHandler(app);
  await app.register(rotas, prefixo ? { prefix: prefixo } : {});
  await app.ready();

  return app;
}

/** Gera um Bearer válido para rotas protegidas por `jwtAuth`. */
export function bearerDe(app: FastifyInstance, payload: Record<string, unknown>): string {
  return `Bearer ${app.jwt.sign(payload)}`;
}
