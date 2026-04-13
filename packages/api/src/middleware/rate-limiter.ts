import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

/**
 * Register global rate limiting with per-API overrides.
 * Each SheetApi has a configurable `rateLimitRpm`.
 * The key is API ID + client IP so limits are scoped per consumer per API.
 */
export async function registerRateLimiter(app: FastifyInstance) {
  await app.register(rateLimit, {
    global: false, // only apply where explicitly enabled
  });
}

/**
 * Per-route rate limit config generator.
 * Use as route-level config: { config: { rateLimit: getApiRateLimit(request) } }
 */
export function apiRateLimitOptions() {
  return {
    max: (request: any) => {
      const sheetApi = request.sheetApi;
      return sheetApi?.rateLimitRpm ?? 60;
    },
    timeWindow: '1 minute',
    keyGenerator: (request: any) => {
      const sheetApi = request.sheetApi;
      const apiId = sheetApi?.id ?? 'global';
      return `${apiId}:${request.ip}`;
    },
  };
}
