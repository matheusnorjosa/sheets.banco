import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

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
}
