import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';

interface SheetApiHmac {
  hmacSecret: string | null;
  requireSigning: boolean;
}

const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Middleware that verifies HMAC request signatures.
 * Only enforced if SheetApi.requireSigning is true.
 *
 * Expected headers:
 * - X-Signature: HMAC-SHA256 hex digest
 * - X-Timestamp: Unix timestamp (seconds)
 */
export async function hmacVerify(request: FastifyRequest, reply: FastifyReply) {
  const sheetApi = (request as any).sheetApi as SheetApiHmac | undefined;
  if (!sheetApi || !sheetApi.requireSigning || !sheetApi.hmacSecret) return;

  const signature = request.headers['x-signature'] as string | undefined;
  const timestamp = request.headers['x-timestamp'] as string | undefined;

  if (!signature || !timestamp) {
    return reply.status(401).send({
      error: true,
      message: 'Missing X-Signature or X-Timestamp headers.',
      code: 'SIGNATURE_MISSING',
      statusCode: 401,
    });
  }

  // Check timestamp drift (replay prevention)
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

  // Build canonical string: METHOD\nPATH\nTIMESTAMP\nBODY_HASH
  const bodyStr = request.body ? JSON.stringify(request.body) : '';
  const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const canonical = `${request.method}\n${request.url}\n${timestamp}\n${bodyHash}`;

  const expected = crypto
    .createHmac('sha256', sheetApi.hmacSecret)
    .update(canonical)
    .digest('hex');

  // Timing-safe comparison
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
