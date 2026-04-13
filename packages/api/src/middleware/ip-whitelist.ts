import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Per-API IP whitelist middleware.
 * If `ipWhitelist` is set on the SheetApi, only those IPs are allowed.
 * null/undefined → all IPs allowed.
 */
export async function apiIpWhitelist(request: FastifyRequest, reply: FastifyReply) {
  const sheetApi = (request as any).sheetApi as { ipWhitelist?: string | null } | undefined;
  if (!sheetApi || !sheetApi.ipWhitelist) return;

  const allowed = sheetApi.ipWhitelist.split(',').map((ip) => ip.trim());
  const clientIp = request.ip;

  if (!allowed.includes(clientIp)) {
    return reply.status(403).send({
      error: true,
      message: 'Your IP address is not allowed.',
      code: 'IP_FORBIDDEN',
      statusCode: 403,
    });
  }
}
