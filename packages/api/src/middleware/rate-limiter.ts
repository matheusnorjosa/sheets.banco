import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';

/**
 * Register global rate limiting with per-API overrides.
 * Each SheetApi has a configurable `rateLimitRpm`.
 * The key is API ID + client IP so limits are scoped per consumer per API.
 *
 * When Redis is available (`app.redis !== null`) the limiter uses the shared
 * store so counters stay coherent across multiple instances. Without Redis it
 * falls back to in-process memory (fine for single-instance dev).
 */
export async function registerRateLimiter(app: FastifyInstance) {
  await app.register(rateLimit, {
    global: false, // only apply where explicitly enabled
    redis: app.redis ?? undefined,
  });
}

/**
 * Per-route rate limit config generator.
 * Use as route-level config: { config: { rateLimit: apiRateLimitOptions() } }
 */
export function apiRateLimitOptions() {
  return {
    max: (request: FastifyRequest) => request.sheetApi?.rateLimitRpm ?? 60,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => {
      const apiId = request.sheetApi?.id ?? 'global';
      return `${apiId}:${request.ip}`;
    },
  };
}

/**
 * Strict per-IP rate limit for authentication routes.
 * Login/register/2FA are the main brute-force targets, so they get a much
 * tighter window than the dashboard routes. `global: true` makes the plugin
 * apply to every route registered in the enclosing scope.
 */
export function authRateLimitOptions() {
  return {
    global: true,
    max: 10,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => `auth:${request.ip}`,
  };
}

/**
 * Permissive rate limit for authenticated dashboard routes — protects against
 * runaway clients without blocking normal UI use.
 */
export function dashboardRateLimitOptions() {
  return {
    global: true,
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => {
      const userId = (request.user as { sub?: string } | undefined)?.sub;
      return userId ? `dashboard:user:${userId}` : `dashboard:ip:${request.ip}`;
    },
  };
}
