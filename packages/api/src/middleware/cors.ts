import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Per-API CORS middleware.
 * Reads `corsOrigins` from the resolved SheetApi:
 * - null/undefined → Access-Control-Allow-Origin: *
 * - comma-separated list → only those origins allowed
 */
export async function apiCors(request: FastifyRequest, reply: FastifyReply) {
  const sheetApi = request.sheetApi;
  if (!sheetApi) return;

  const origin = request.headers.origin ?? '';

  if (!sheetApi.corsOrigins) {
    // No restrictions — allow all
    reply.header('Access-Control-Allow-Origin', '*');
  } else {
    // `filter(Boolean)` não é higiene: sem ele, uma vírgula sobrando
    // (`"https://a.com,"`) coloca uma string vazia na lista. Como requisição
    // sem header `Origin` chega aqui com `origin === ''` (o `?? ''` acima),
    // ela passaria a "estar na lista" — o middleware responderia
    // `Access-Control-Allow-Origin:` com valor vazio e o preflight sem Origin
    // devolveria 204 em vez de 403. Um caractere a mais no dashboard mudava o
    // comportamento.
    //
    // O `origin &&` fecha o outro lado: origem ausente nunca casa, mesmo que
    // alguém consiga colocar vazio na lista por outro caminho.
    const allowed = sheetApi.corsOrigins.split(',').map((o) => o.trim()).filter(Boolean);
    if (origin && allowed.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    } else {
      // Origin not allowed — don't set the header (browser will block)
      if (request.method === 'OPTIONS') {
        return reply.status(403).send({
          error: true,
          message: 'Origin not allowed.',
          code: 'CORS_FORBIDDEN',
          statusCode: 403,
        });
      }
    }
  }

  reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  reply.header('Access-Control-Max-Age', '86400');

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return reply.status(204).send();
  }
}
