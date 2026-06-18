import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Standalone pino logger for code paths outside the Fastify request lifecycle
 * (BullMQ workers, batch flushers, shutdown hooks). Fastify itself logs via
 * `app.log` — use that inside handlers. This logger exists so workers don't
 * fall back to `console.*`, which bypasses the structured JSON stream and
 * makes log filtering in production impossible.
 *
 * Children identify themselves with a `component` tag (e.g.
 * `logger.child({ component: 'worker:sheets-write' })`) so log queries like
 * `component:"worker:webhook-delivery" level:50` work without grep gymnastics.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'sheets-banco-api' },
});
