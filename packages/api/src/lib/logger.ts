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
/**
 * Paths pino redacts from every log line — used by this standalone logger and
 * by the Fastify request logger in index.ts. Defense-in-depth: keeps
 * credentials/PII out of the log stream even if an error or job payload carries
 * them. Non-matching paths are ignored; secrets are still primarily protected
 * at the storage layer (secret-cipher, bcrypt).
 */
export const redactPaths = [
  // request headers that carry credentials
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-signature"]',
  'res.headers["set-cookie"]',
  // secrets & PII — top level and one level deep
  'password', 'passwordHash', 'hmacSecret', 'secret', 'bearerToken', 'bearerTokenHash',
  'basicPass', 'basicPassHash', 'keyHash', 'googleAccessToken', 'googleRefreshToken', 'cpf',
  '*.password', '*.passwordHash', '*.hmacSecret', '*.secret', '*.bearerToken',
  '*.basicPass', '*.googleAccessToken', '*.googleRefreshToken', '*.cpf',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'sheets-banco-api' },
  redact: { paths: redactPaths, censor: '[REDACTED]' },
});
