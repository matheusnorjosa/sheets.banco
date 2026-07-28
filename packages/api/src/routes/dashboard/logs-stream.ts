import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';
import { dashboardRateLimitOptions } from '../../middleware/rate-limiter.js';

export async function logsStreamRoutes(app: FastifyInstance) {
  await app.register(import('@fastify/rate-limit'), dashboardRateLimitOptions() as any);
  // `onRequest`, como nos outros seis arquivos de dashboard — e nao
  // `preHandler` na rota, como era antes.
  //
  // O motivo nao e uniformidade: o `@fastify/rate-limit` engancha em
  // `onRequest`, e o `keyGenerator` de `dashboardRateLimitOptions` le
  // `request.user.sub`. Com o jwtAuth em `preHandler` — que roda DEPOIS — o
  // usuario ainda nao existia na hora de gerar a chave, e o balde de 60 rpm
  // caia para `dashboard:ip:`. Um escritorio inteiro atras de NAT dividia um
  // balde so.
  app.addHook('onRequest', jwtAuth);

  // GET /dashboard/apis/:id/logs/stream — SSE endpoint for live logs
  app.get('/:id/logs/stream', async (request, reply) => {
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

        const last = logs[logs.length - 1];
        if (last) {
          lastChecked = last.createdAt;
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
