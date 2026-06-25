import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

const GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Constant-time equality for ASCII/UTF-8 strings. Used for the legacy
 * plaintext fallback path during the bcrypt migration window (#99). bcrypt's
 * own compare is constant-time relative to the hash, so we only need this
 * helper for the fallback branch.
 */
function equalConstantTime(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify `input` against either a bcrypt hash (preferred) or a legacy
 * plaintext string (transition fallback). At least one of `hash` / `plain`
 * must be non-null — if both are null the caller has no credential
 * configured and shouldn't be calling this in the first place.
 *
 * The dual-read order matters: we always check the hash first when present,
 * so once a row has been backfilled the legacy plaintext path becomes dead
 * code for that row. After the legacy column drops in the second migration,
 * this whole helper collapses to `bcrypt.compare(input, hash)`.
 */
async function verifyCredential(
  input: string,
  hash: string | null,
  plain: string | null,
): Promise<boolean> {
  if (hash) {
    try {
      return await bcrypt.compare(input, hash);
    } catch {
      return false;
    }
  }
  if (plain) {
    return equalConstantTime(input, plain);
  }
  return false;
}

/**
 * Middleware that checks per-API auth (bearer token or basic auth).
 * Supports token rotation with a 1-hour grace period for the previous token.
 *
 * During the #99 bcrypt migration: reads tolerate either hash or plaintext
 * per row (see verifyCredential). Writes (rotate, PATCH) populate both
 * columns so any row touched by an operator gets the hash for free.
 */
export async function apiAuth(request: FastifyRequest, reply: FastifyReply) {
  const sheetApi = request.sheetApi;
  if (!sheetApi) return;

  const hasBearerAuth = !!sheetApi.bearerToken || !!sheetApi.bearerTokenHash;
  const hasBasicAuth = !!sheetApi.basicUser && (!!sheetApi.basicPass || !!sheetApi.basicPassHash);

  // No auth configured — endpoint is public
  if (!hasBearerAuth && !hasBasicAuth) return;

  const authHeader = request.headers.authorization ?? '';

  // Try Bearer token
  if (hasBearerAuth && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    if (await verifyCredential(token, sheetApi.bearerTokenHash, sheetApi.bearerToken)) {
      return;
    }

    // Previous token (grace period)
    if (
      (sheetApi.bearerTokenPreviousHash || sheetApi.bearerTokenPrevious) &&
      sheetApi.bearerTokenRotatedAt &&
      Date.now() - sheetApi.bearerTokenRotatedAt.getTime() < GRACE_PERIOD_MS &&
      (await verifyCredential(token, sheetApi.bearerTokenPreviousHash, sheetApi.bearerTokenPrevious))
    ) {
      return;
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
        equalConstantTime(user, sheetApi.basicUser) &&
        (await verifyCredential(pass, sheetApi.basicPassHash, sheetApi.basicPass))
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
