import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Per-API IP whitelist middleware.
 * If `ipWhitelist` is set on the SheetApi, only those IPs are allowed.
 * null/undefined → all IPs allowed.
 */
export async function apiIpWhitelist(request: FastifyRequest, reply: FastifyReply) {
  const sheetApi = request.sheetApi;
  if (!sheetApi || !sheetApi.ipWhitelist) return;

  // `filter(Boolean)` pelo mesmo motivo do `middleware/cors.ts`: vírgula
  // sobrando põe string vazia na lista. Aqui o efeito é inerte, porque
  // `request.ip` nunca é vazio — mas deixar entrada morta numa lista de
  // controle de acesso é convite a alguém replicar o padrão onde ele morde.
  const allowed = sheetApi.ipWhitelist.split(',').map((ip) => ip.trim()).filter(Boolean);
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
