import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';

export async function logsStreamRoutes(app: FastifyInstance) {
  // GET /dashboard/apis/:id/logs/stream — SSE endpoint for live logs
  app.get('/:id/logs/stream', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId: sub } });
    if (!existing) throw new NotFoundError('API not found.');

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    let lastChecked = new Date();

    // Poll for new logs every 2 seconds
    const interval = setInterval(async () => {
      try {
        const logs = await prisma.usageLog.findMany({
          where: { sheetApiId: id, createdAt: { gt: lastChecked } },
          orderBy: { createdAt: 'asc' },
          take: 20,
          select: {
            method: true,
            path: true,
            statusCode: true,
            responseMs: true,
            ip: true,
            createdAt: true,
          },
        });

        if (logs.length > 0) {
          lastChecked = logs[logs.length - 1].createdAt;
          for (const log of logs) {
            reply.raw.write(`data: ${JSON.stringify(log)}\n\n`);
          }
        }
      } catch {
        // Connection may have closed
      }
    }, 2000);

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        // Connection closed
      }
    }, 30000);

    request.raw.on('close', () => {
      clearInterval(interval);
      clearInterval(heartbeat);
    });
  });
}
