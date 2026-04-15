import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { jwtAuth } from '../../middleware/jwt-auth.js';

const createFieldSchema = z.object({
  name: z.string().min(1).max(50).regex(/^\w+$/, 'Name must be alphanumeric with underscores'),
  expression: z.string().min(1).max(500),
});

function getUserId(request: any): string {
  return (request.user as { sub: string }).sub;
}

export async function computedFieldRoutes(app: FastifyInstance) {
  app.addHook('onRequest', jwtAuth);

  // GET /dashboard/apis/:id/computed-fields — list computed fields
  app.get('/:id/computed-fields', async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const fields = await prisma.computedField.findMany({
      where: { sheetApiId: id },
      orderBy: { createdAt: 'asc' },
    });

    return { fields };
  });

  // POST /dashboard/apis/:id/computed-fields — create a computed field
  app.post('/:id/computed-fields', async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const parsed = createFieldSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Provide a valid "name" and "expression".');
    }

    // Check for duplicate name
    const duplicate = await prisma.computedField.findUnique({
      where: { sheetApiId_name: { sheetApiId: id, name: parsed.data.name } },
    });
    if (duplicate) {
      throw new ValidationError(`Computed field "${parsed.data.name}" already exists.`);
    }

    const field = await prisma.computedField.create({
      data: {
        sheetApiId: id,
        name: parsed.data.name,
        expression: parsed.data.expression,
      },
    });

    return reply.status(201).send({ field });
  });

  // PATCH /dashboard/apis/:id/computed-fields/:fieldId — update expression
  app.patch('/:id/computed-fields/:fieldId', async (request) => {
    const userId = getUserId(request);
    const { id, fieldId } = request.params as { id: string; fieldId: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const body = request.body as { expression?: string };
    if (!body?.expression) {
      throw new ValidationError('Provide an "expression".');
    }

    const field = await prisma.computedField.findFirst({
      where: { id: fieldId, sheetApiId: id },
    });
    if (!field) throw new NotFoundError('Computed field not found.');

    const updated = await prisma.computedField.update({
      where: { id: fieldId },
      data: { expression: body.expression },
    });

    return { field: updated };
  });

  // DELETE /dashboard/apis/:id/computed-fields/:fieldId — delete a computed field
  app.delete('/:id/computed-fields/:fieldId', async (request) => {
    const userId = getUserId(request);
    const { id, fieldId } = request.params as { id: string; fieldId: string };

    const existing = await prisma.sheetApi.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('API not found.');

    const field = await prisma.computedField.findFirst({
      where: { id: fieldId, sheetApiId: id },
    });
    if (!field) throw new NotFoundError('Computed field not found.');

    await prisma.computedField.delete({ where: { id: fieldId } });
    return { deleted: true };
  });
}
