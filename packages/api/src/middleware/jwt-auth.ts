import type { FastifyRequest, FastifyReply } from 'fastify';
import { ehTokenDeSessao, type JwtPayload } from '../lib/jwt-purpose.js';

export async function jwtAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({
      error: true,
      message: 'Authentication required.',
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  }

  // Assinatura válida não basta. Todo JWT desta API sai do mesmo segredo, então
  // um token de etapa intermediária — o do 2FA ainda não verificado, à frente —
  // atravessa o `jwtVerify` idêntico a um de sessão. Ver `lib/jwt-purpose.ts`.
  if (!ehTokenDeSessao(request.user as JwtPayload)) {
    return reply.status(401).send({
      error: true,
      message: 'This token cannot be used to authenticate requests.',
      code: 'TOKEN_WRONG_PURPOSE',
      statusCode: 401,
    });
  }
}
