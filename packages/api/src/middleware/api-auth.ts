import type { FastifyRequest, FastifyReply } from 'fastify';

interface SheetApiAuth {
  bearerToken: string | null;
  bearerTokenPrevious: string | null;
  bearerTokenRotatedAt: Date | null;
  basicUser: string | null;
  basicPass: string | null;
}

const GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Middleware that checks per-API auth (bearer token or basic auth).
 * Supports token rotation with a 1-hour grace period for the previous token.
 */
export async function apiAuth(request: FastifyRequest, reply: FastifyReply) {
  const sheetApi = (request as any).sheetApi as SheetApiAuth | undefined;
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
    if (token === sheetApi.bearerToken) return;

    // Check previous token (grace period)
    if (
      sheetApi.bearerTokenPrevious &&
      token === sheetApi.bearerTokenPrevious &&
      sheetApi.bearerTokenRotatedAt
    ) {
      const elapsed = Date.now() - sheetApi.bearerTokenRotatedAt.getTime();
      if (elapsed < GRACE_PERIOD_MS) return;
    }
  }

  // Try Basic auth
  if (hasBasicAuth && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const [user, pass] = decoded.split(':');
    if (user === sheetApi.basicUser && pass === sheetApi.basicPass) return;
  }

  return reply.status(401).send({
    error: true,
    message: 'Invalid or missing authentication.',
    code: 'API_UNAUTHORIZED',
    statusCode: 401,
  });
}
