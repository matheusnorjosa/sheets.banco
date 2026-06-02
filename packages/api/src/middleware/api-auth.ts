import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';

const GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Constant-time equality for ASCII/UTF-8 strings. `===` short-circuits on the
 * first mismatched byte, leaking length and prefix information through timing
 * — irrelevant over jittery TLS in practice, but the right primitive at the
 * crypto boundary. Mirrors the comparison already used in hmac-verify.ts.
 */
function equalConstantTime(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Middleware that checks per-API auth (bearer token or basic auth).
 * Supports token rotation with a 1-hour grace period for the previous token.
 */
export async function apiAuth(request: FastifyRequest, reply: FastifyReply) {
  const sheetApi = request.sheetApi;
  if (!sheetApi) return;

  const hasBearerAuth = !!sheetApi.bearerToken;
  const hasBasicAuth = !!sheetApi.basicUser && !!sheetApi.basicPass;

  // No auth configured — endpoint is public
  if (!hasBearerAuth && !hasBasicAuth) return;

  const authHeader = request.headers.authorization ?? '';

  // Try Bearer token
  if (hasBearerAuth && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    // Check current token
    if (sheetApi.bearerToken && equalConstantTime(token, sheetApi.bearerToken)) return;

    // Check previous token (grace period)
    if (
      sheetApi.bearerTokenPrevious &&
      sheetApi.bearerTokenRotatedAt &&
      equalConstantTime(token, sheetApi.bearerTokenPrevious)
    ) {
      const elapsed = Date.now() - sheetApi.bearerTokenRotatedAt.getTime();
      if (elapsed < GRACE_PERIOD_MS) return;
    }
  }

  // Try Basic auth
  if (hasBasicAuth && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const sep = decoded.indexOf(':');
    if (sep > 0) {
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (
        sheetApi.basicUser &&
        sheetApi.basicPass &&
        equalConstantTime(user, sheetApi.basicUser) &&
        equalConstantTime(pass, sheetApi.basicPass)
      ) {
        return;
      }
    }
  }

  return reply.status(401).send({
    error: true,
    message: 'Invalid or missing authentication.',
    code: 'API_UNAUTHORIZED',
    statusCode: 401,
  });
}
