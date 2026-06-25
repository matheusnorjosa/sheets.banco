import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { decryptIfEncrypted } from '../lib/secret-cipher.js';

const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

/**
 * Verifies HMAC request signatures when the SheetApi has `requireSigning`.
 *
 * Two signing versions exist:
 *
 * - **v2 (current, default for new clients)** — hashes the raw request bytes.
 *   Stable across language ecosystems because both ends agree on the exact
 *   payload bytes, not on a parser's re-serialization of them.
 *   Requires `request.rawBody` to be populated (see fastify-raw-body in
 *   `index.ts`). Client must send `X-Signature-Version: 2`.
 *
 * - **v1 (legacy, deprecated)** — hashes `JSON.stringify(request.body)`.
 *   Fragile: any client whose JSON serializer disagrees with V8's (key order,
 *   number formatting, escape encoding) produces a different signature for
 *   the same logical payload. Kept for back-compat with clients that signed
 *   against the old contract; new integrations must use v2.
 *
 * Canonical string in both versions:
 *     METHOD\nPATH\nTIMESTAMP\nHEX(SHA256(body))
 *
 * Headers:
 *   X-Signature           HMAC-SHA256 hex digest of the canonical string
 *   X-Timestamp           Unix seconds; rejected if drift > 5 min
 *   X-Signature-Version   '1' | '2' — defaults to '1' when absent so existing
 *                         clients keep working until they migrate.
 */
export async function hmacVerify(request: FastifyRequest, reply: FastifyReply) {
  const sheetApi = request.sheetApi;
  if (!sheetApi || !sheetApi.requireSigning || !sheetApi.hmacSecret) return;

  const signature = request.headers['x-signature'] as string | undefined;
  const timestamp = request.headers['x-timestamp'] as string | undefined;
  const version = (request.headers['x-signature-version'] as string | undefined) ?? '1';

  if (!signature || !timestamp) {
    return reply.status(401).send({
      error: true,
      message: 'Missing X-Signature or X-Timestamp headers.',
      code: 'SIGNATURE_MISSING',
      statusCode: 401,
    });
  }

  const requestTime = Number(timestamp) * 1000;
  const drift = Math.abs(Date.now() - requestTime);
  if (isNaN(requestTime) || drift > MAX_TIMESTAMP_DRIFT_MS) {
    return reply.status(401).send({
      error: true,
      message: 'Request timestamp is too old or invalid.',
      code: 'SIGNATURE_EXPIRED',
      statusCode: 401,
    });
  }

  let bodyBytes: string | Buffer;
  if (version === '2') {
    // v2: raw bytes captured by fastify-raw-body. Undefined → GET-style empty.
    bodyBytes = request.rawBody ?? '';
  } else {
    // v1: legacy JSON.stringify path. Body is parsed by the time preHandler
    // runs, but for GETs body is undefined → empty string.
    bodyBytes = request.body ? JSON.stringify(request.body) : '';
  }
  const bodyHash = crypto.createHash('sha256').update(bodyBytes).digest('hex');
  const canonical = `${request.method}\n${request.url}\n${timestamp}\n${bodyHash}`;

  // hmacSecret may be stored encrypted (gcm$…) or legacy plaintext during the
  // migration window. decryptIfEncrypted handles both transparently.
  const hmacSecretPlain = decryptIfEncrypted(sheetApi.hmacSecret);

  const expected = crypto
    .createHmac('sha256', hmacSecretPlain)
    .update(canonical)
    .digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expBuffer = Buffer.from(expected, 'hex');

  if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
    return reply.status(401).send({
      error: true,
      message: 'Invalid request signature.',
      code: 'SIGNATURE_INVALID',
      statusCode: 401,
    });
  }
}
