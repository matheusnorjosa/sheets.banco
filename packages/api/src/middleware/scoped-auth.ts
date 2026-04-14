import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';

/**
 * Middleware factory that checks if the request has the required scopes.
 * Looks for API key in the X-Api-Key header.
 * If no API key is provided, this middleware is skipped (other auth may apply).
 */
export function requireScopes(...required: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyHeader = request.headers['x-api-key'] as string | undefined;
    if (!apiKeyHeader) return; // No API key — skip scope check

    const apiKey = await prisma.apiKey.findUnique({
      where: { key: apiKeyHeader },
    });

    if (!apiKey || !apiKey.active) {
      return reply.status(401).send({
        error: true,
        message: 'Invalid or inactive API key.',
        code: 'INVALID_API_KEY',
        statusCode: 401,
      });
    }

    // Check expiration
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return reply.status(401).send({
        error: true,
        message: 'API key has expired.',
        code: 'API_KEY_EXPIRED',
        statusCode: 401,
      });
    }

    // Check scopes
    const missing = required.filter((s) => !apiKey.scopes.includes(s));
    if (missing.length > 0) {
      return reply.status(403).send({
        error: true,
        message: `Missing scopes: ${missing.join(', ')}`,
        code: 'INSUFFICIENT_SCOPES',
        statusCode: 403,
      });
    }

    // Update lastUsedAt (fire and forget)
    prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => {});

    // Attach API key to request
    (request as any).apiKey = apiKey;
  };
}
