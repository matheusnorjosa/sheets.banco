import crypto from 'node:crypto';
import type { NormalizedUser } from '../normalize/types/users.js';
import type { NormalizedProduto } from '../normalize/types/produtos.js';
import type { NormalizedAgenda } from '../normalize/types/agenda.js';
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
    ordered[k] = raw[k];
  }
  return sha256(JSON.stringify(ordered));
}

/**
 * Type-specific idempotency hash. Returns null for unknown types — without a
 * stable contract the hash would give a false sense of dedup-ability.
 */
export function importHash(
  type: SheetType,
  normalized: NormalizedUser | NormalizedProduto | NormalizedAgenda | null,
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
    default:
      return null;
  }
}
