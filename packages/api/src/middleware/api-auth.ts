import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma.js';
import { findApiKeyByPlaintext } from '../lib/api-key-lookup.js';

const GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

/**
 * How stale `ApiKey.lastUsedAt` is allowed to get before we refresh it. Without
 * this every authenticated request would issue a write just to move a timestamp
 * a few milliseconds; 5 minutes keeps "is this key still in use?" answerable
 * before revoking one, at roughly zero cost.
 */
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

interface AuthErrorBody {
  error: true;
  message: string;
  code: string;
  statusCode: number;
}

function authError(statusCode: number, code: string, message: string): AuthErrorBody {
  return { error: true, message, code, statusCode };
}

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
 * Scope an ApiKey must carry to use a given HTTP method, mirroring the
 * `sheets:read` / `sheets:write` / `sheets:delete` triple that `ApiKey.scopes`
 * has defaulted to since the model was introduced.
 *
 * An absent or unrecognized method is treated as a write — fail closed.
 */
function scopeForMethod(method: string | undefined): string {
  switch ((method ?? '').toUpperCase()) {
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
      return 'sheets:read';
    case 'DELETE':
      return 'sheets:delete';
    default:
      return 'sheets:write';
  }
}

type ApiKeyOutcome =
  | { ok: true; apiKeyId: string; refreshLastUsed: boolean }
  // `error: null` means "not a key" — the caller falls through to the generic
  // 401 instead of confirming anything about what does or doesn't exist.
  | { ok: false; error: AuthErrorBody | null };

/**
 * Verify a candidate secret as an `ApiKey` belonging to *this* SheetApi.
 *
 * Unlike `sheetApi.bearerToken` — one shared secret per API, held by the Apps
 * Script consumers — API keys are many-per-API, labelled, individually
 * revocable and scoped. That's what makes one safe to hand to an ad-hoc client
 * without touching the credential production depends on.
 */
async function verifyApiKey(
  candidate: string,
  sheetApiId: string,
  method: string | undefined,
): Promise<ApiKeyOutcome> {
  const apiKey = await findApiKeyByPlaintext(candidate);

  // The lookup is global (keys are unique across the whole table), so this
  // ownership check is the thing standing between a key minted for one
  // spreadsheet and every other spreadsheet on the account. Do not remove it.
  if (!apiKey || apiKey.sheetApiId !== sheetApiId) {
    return { ok: false, error: null };
  }

  if (!apiKey.active) {
    return { ok: false, error: authError(401, 'INVALID_API_KEY', 'API key is inactive.') };
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return { ok: false, error: authError(401, 'API_KEY_EXPIRED', 'API key has expired.') };
  }

  const required = scopeForMethod(method);
  if (!apiKey.scopes.includes(required)) {
    return {
      ok: false,
      error: authError(403, 'INSUFFICIENT_SCOPES', `Missing scope: ${required}`),
    };
  }

  return {
    ok: true,
    apiKeyId: apiKey.id,
    refreshLastUsed:
      !apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS,
  };
}

/**
 * Middleware that checks per-API auth. Three credentials are accepted, in
 * order: the API's bearer token, basic auth, then an `ApiKey` row belonging to
 * this API (sent as `X-API-Key`, or as `Authorization: Bearer` so clients that
 * only speak bearer can use one).
 *
 * Bearer token is tried first so consumer traffic — which always carries it —
 * never pays for the API-key database lookup.
 *
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

  // No bearer/basic configured — endpoint is public, and stays public even if
  // API keys exist for it. Keys narrow *who* gets in on an API that already
  // requires a credential; they can't retroactively close one that doesn't.
  // The dashboard warns when a key is minted on an API in this state.
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

  // Try an API key. Accepted from `X-API-Key`, or from the bearer value when it
  // didn't match the API's own token — one header, two kinds of credential.
  const keyCandidate =
    (request.headers['x-api-key'] as string | undefined) ||
    (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined);

  if (keyCandidate) {
    const outcome = await verifyApiKey(keyCandidate, sheetApi.id, request.method);

    if (outcome.ok) {
      if (outcome.refreshLastUsed) {
        // Fire and forget: a failed timestamp write must never fail a request
        // the caller was otherwise authorized to make.
        prisma.apiKey
          .update({ where: { id: outcome.apiKeyId }, data: { lastUsedAt: new Date() } })
          .catch(() => {});
      }
      return;
    }

    if (outcome.error) {
      return reply.status(outcome.error.statusCode).send(outcome.error);
    }
  }

  return reply
    .status(401)
    .send(authError(401, 'API_UNAUTHORIZED', 'Invalid or missing authentication.'));
}
