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
    retryStrategy(times: number) {
      if (times > 10) return null; // stop retrying after 10 attempts
      return Math.min(times * 200, 5000);
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
