import type { FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';

export interface AuditEntry {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  sheetApiId?: string;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  ip?: string;
  userAgent?: string;
}

const buffer: AuditEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

async function flush(): Promise<void> {
  if (buffer.length === 0) return;

  const batch = buffer.splice(0, buffer.length);

  try {
    await prisma.auditLog.createMany({
      data: batch.map((entry) => ({
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        sheetApiId: entry.sheetApiId ?? null,
        changes: entry.changes as any ?? undefined,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      })),
    });
  } catch {
    // Silently fail — audit logging should not break the app
  }
}

/**
 * Log an audit event. Buffered and flushed every 2 seconds or at 50 entries.
 */
export function audit(entry: AuditEntry): void {
  buffer.push(entry);

  if (buffer.length >= 50) {
    flush();
  }

  if (!flushTimer) {
    flushTimer = setInterval(() => {
      flush();
    }, 2000);
  }
}

/**
 * Campos cujo VALOR nunca entra na trilha.
 *
 * Para eles a auditoria registra apenas se o campo passou a existir ou deixou
 * de existir. É a informação que importa numa investigação — *"alguém tirou o
 * bearer às 3h da manhã"* — sem transformar o `AuditLog` num segundo lugar
 * onde o segredo mora. Uma trilha de auditoria costuma ter retenção longa e
 * acesso mais amplo que a tabela original; copiar credencial para dentro dela
 * desfaz o trabalho do `secret-cipher`.
 */
const CAMPOS_SECRETOS = new Set([
  'bearerToken', 'bearerTokenHash',
  'basicPass', 'basicPassHash',
  'hmacSecret', 'key', 'keyHash',
]);

function marcarPresenca(valor: unknown): string {
  return valor ? '[definido]' : '[ausente]';
}

/**
 * Monta o `changes` de um update, comparando o registro antes e o depois.
 * Devolve `null` quando nada mudou — o campo é opcional no schema e gravar
 * `{}` só polui.
 */
export function diffAuditavel(
  antes: Record<string, unknown>,
  depois: Record<string, unknown>,
): Record<string, { old: unknown; new: unknown }> | null {
  const changes: Record<string, { old: unknown; new: unknown }> = {};

  for (const [campo, novo] of Object.entries(depois)) {
    const velho = antes[campo];
    if (velho === novo) continue;

    changes[campo] = CAMPOS_SECRETOS.has(campo)
      ? { old: marcarPresenca(velho), new: marcarPresenca(novo) }
      : { old: velho, new: novo };
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Registra um evento a partir da requisição, preenchendo ator, IP e
 * user-agent — os três campos que respondem "quem, de onde" depois.
 *
 * Sem ator identificado não há trilha útil, então a chamada é ignorada em vez
 * de gravar uma linha órfã. Na prática isso não acontece: todas as rotas que
 * auditam rodam atrás do `jwtAuth`.
 */
export function auditarRequisicao(
  request: FastifyRequest,
  entrada: Omit<AuditEntry, 'actorId' | 'ip' | 'userAgent'>,
): void {
  const actorId = (request.user as { sub?: string } | undefined)?.sub;
  if (!actorId) return;

  audit({
    ...entrada,
    actorId,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
  });
}

/**
 * Force flush remaining entries (call on shutdown).
 */
export async function flushAuditLog(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();
}
