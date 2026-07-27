import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis | null;
  }
}

const DEFAULT_LOCAL = 'redis://localhost:6379';

export default fp(async (app: FastifyInstance) => {
  // If REDIS_URL was not explicitly set, skip Redis entirely. Cache becomes a
  // no-op (cache.service handles redis === null) instead of burning seconds per
  // request on ECONNREFUSED retries.
  if (!process.env.REDIS_URL || env.REDIS_URL === DEFAULT_LOCAL) {
    app.log.warn('REDIS_URL not configured — running without cache');
    app.decorate('redis', null);
    return;
  }

  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
    connectTimeout: 5000,
    /**
     * Backoff de reconexão, sem desistência permanente.
     *
     * Antes era `if (times > 10) return null`, e `null` no ioredis significa
     * **parar de reconectar para sempre**. Como o backoff somava
     * 200+400+…+2000 = 11 segundos, qualquer queda do Upstash maior que isso
     * desligava o cache até alguém reiniciar o processo — e como o cliente é
     * criado com `enableOfflineQueue: false`, tudo passava a falhar em
     * silêncio, sem log (o `cache.service` engole erro de propósito).
     *
     * O teto de 5000ms também era código morto: só seria atingido em
     * `times >= 25`, e o `return null` saía em 11. O código LIA como "backoff
     * de até 5s" enquanto o máximo real era 2s.
     *
     * Agora o backoff cresce até 30s e continua tentando. Um blip de rede se
     * recupera sozinho; uma queda longa custa uma tentativa a cada 30s, que é
     * barato.
     */
    retryStrategy(times: number) {
      return Math.min(times * 200, 30_000);
    },
  });

  let loggedError = false;
  redis.on('error', (err: Error) => {
    if (!loggedError) {
      app.log.error({ err }, 'Redis connection error (further errors suppressed)');
      loggedError = true;
    }
  });

  redis.on('connect', () => {
    app.log.info('Redis connected');
    loggedError = false;
  });

  app.decorate('redis', redis);

  app.addHook('onClose', async () => {
    await redis.quit().catch(() => {});
  });
});
