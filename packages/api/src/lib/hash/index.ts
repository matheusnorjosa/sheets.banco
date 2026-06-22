import crypto from 'node:crypto';
import type { NormalizedUser } from '../normalize/types/users.js';
import type { NormalizedProduto } from '../normalize/types/produtos.js';
import type { NormalizedAgenda } from '../normalize/types/agenda.js';
import type { NormalizedEvento } from '../normalize/types/eventos.js';
import type { NormalizedBloqueio } from '../normalize/types/bloqueios.js';
import type { NormalizedDeslocamento } from '../normalize/types/deslocamento.js';
import type { NormalizedDisponibilidadeMensal } from '../normalize/types/disponibilidadeMensal.js';
import type { NormalizedDisponibilidadeAnual } from '../normalize/types/disponibilidadeAnual.js';
import type { SheetType } from '../detect/index.js';
import type { RawRow } from '../normalize/row.js';

function sha256(input: string): string {
  return `sha256:${crypto.createHash('sha256').update(input).digest('hex')}`;
}

/**
 * Stable hash of a raw spreadsheet row. Keys are sorted so that key reordering
 * doesn't produce a different hash.
 */
export function rowHash(raw: RawRow): string {
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(raw).sort()) {
    ordered[k] = raw[k] ?? '';
  }
  return sha256(JSON.stringify(ordered));
}

export interface ImportHashContext {
  mes: number | null;
  ano: number | null;
}

/**
 * Type-specific idempotency hash. Returns null when the type lacks a stable
 * contract (unknown sheet, or normalized data missing critical fields).
 */
export function importHash(
  type: SheetType,
  normalized:
    | NormalizedUser
    | NormalizedProduto
    | NormalizedAgenda
    | NormalizedEvento
    | NormalizedBloqueio
    | NormalizedDeslocamento
    | NormalizedDisponibilidadeMensal
    | NormalizedDisponibilidadeAnual
    | null,
  ctx: ImportHashContext = { mes: null, ano: null },
): string | null {
  if (!normalized) return null;

  switch (type) {
    case 'users': {
      const n = normalized as NormalizedUser;
      return sha256(['users', n.cpf, n.email, n.nome_completo].join('|'));
    }
    case 'produtos': {
      const n = normalized as NormalizedProduto;
      return sha256(
        [
          'produtos',
          n.codigo_original,
          n.produto_key,
          n.municipio_key ?? '',
          n.data ?? '',
          n.quantidade ?? '',
        ].join('|'),
      );
    }
    case 'agenda': {
      const n = normalized as NormalizedAgenda;
      return sha256(
        [
          'agenda',
          n.municipio_key ?? '',
          n.data ?? '',
          n.hora_inicio ?? '',
          n.hora_fim ?? '',
          n.projeto_key,
          n.coordenador_key,
          n.formadores_key,
        ].join('|'),
      );
    }
    case 'eventos': {
      const n = normalized as NormalizedEvento;
      // Prefer a real external_id when present (stable across renames). Note:
      // suspicious-boolean ids (SIM/NÃO) have been nulled out upstream, so we
      // never key off them here. Otherwise fall back to the structural fields.
      if (n.external_id) {
        return sha256(['eventos', 'id:' + n.external_id].join('|'));
      }
      // Without an id we need at least enough structure to identify the event.
      if (!n.titulo_key) return null;
      return sha256(
        [
          'eventos',
          n.titulo_key,
          n.municipio_key ?? '',
          n.data ?? '',
          n.hora_inicio ?? '',
          n.hora_fim ?? '',
          n.projeto_key,
        ].join('|'),
      );
    }
    case 'bloqueios': {
      const n = normalized as NormalizedBloqueio;
      if (!n.inicio_iso || !n.fim_iso || !n.usuario_key) return null;
      return sha256(['bloqueios', n.usuario_key, n.inicio_iso, n.fim_iso, n.tipo_key].join('|'));
    }
    case 'deslocamento': {
      const n = normalized as NormalizedDeslocamento;
      // No stable contract unless we have a parseable date and at least one
      // person + origin/destination key.
      if (!n.data || n.pessoas.length === 0) return null;
      return sha256(
        [
          'deslocamento',
          n.data,
          n.pessoas_key,
          n.origem_key ?? '',
          n.destino_key ?? '',
        ].join('|'),
      );
    }
    case 'disponibilidade_mensal': {
      const n = normalized as NormalizedDisponibilidadeMensal;
      if (ctx.mes === null || ctx.ano === null || !n.usuario_key) return null;
      const slotsKey = n.slots
        .map((s) => `${s.dia}:${s.valor_key ?? ''}`)
        .join(',');
      return sha256(
        ['disp_mensal', n.usuario_key, String(ctx.ano), String(ctx.mes), slotsKey].join('|'),
      );
    }
    case 'disponibilidade_anual': {
      const n = normalized as NormalizedDisponibilidadeAnual;
      if (ctx.ano === null || !n.usuario_key) return null;
      const mesesKey = n.meses
        .map((m) => `${m.mes}:${m.valor_normalizado ?? ''}`)
        .join(',');
      return sha256(
        [
          'disp_anual',
          n.usuario_key,
          String(ctx.ano),
          mesesKey,
          n.ranking ?? '',
        ].join('|'),
      );
    }
    default:
      return null;
  }
}
