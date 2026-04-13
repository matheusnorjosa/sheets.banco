import type { FastifyRequest, FastifyReply } from 'fastify';

interface SheetApiAuth {
  bearerToken: string | null;
  basicUser: string | null;
  basicPass: string | null;
}

/**
 * Middleware that checks per-API auth (bearer token or basic auth).
 * Only enforced if the SheetApi has auth configured. If no auth is set, the endpoint is public.
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
    if (token === sheetApi.bearerToken) return;
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
