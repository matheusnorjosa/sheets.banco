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

/**
 * Strict per-IP rate limit for authentication routes.
 * Login/register/2FA are the main brute-force targets, so they get a much
 * tighter window than the dashboard routes.
 */
export function authRateLimitOptions() {
  return {
    max: 10,
    timeWindow: '1 minute',
    keyGenerator: (request: any) => `auth:${request.ip}`,
  };
}

/**
 * Permissive rate limit for authenticated dashboard routes — protects against
 * runaway clients without blocking normal UI use.
 */
export function dashboardRateLimitOptions() {
  return {
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (request: any) => {
      const userId = (request.user as { sub?: string } | undefined)?.sub;
      return userId ? `dashboard:user:${userId}` : `dashboard:ip:${request.ip}`;
    },
  };
}
