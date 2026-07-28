export interface SheetsBancoConfig {
  apiId: string;
  baseUrl?: string;
  bearerToken?: string;
}

export interface ReadOptions {
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc' | 'random';
  cast_numbers?: boolean;
  single_object?: boolean;
  sheet?: string;
}

export interface SearchOptions extends ReadOptions {
  casesensitive?: boolean;
}

/**
 * Reexportado de `@sheets-banco/shared` — fonte de verdade única do contrato.
 *
 * Havia aqui um `Record<string, string | number>` local que divergia da
 * definição da API (`{ [k: string]: string }`). Não era descuido de um dos
 * lados: a API devolve string por padrão e number quando o cliente pede
 * `?cast_numbers=true`. Os dois tipos existem agora, com nomes diferentes, em
 * vez de um tipo só errado nos dois casos.
 */
export type { SheetRow, SheetRowCastNumbers } from '@sheets-banco/shared';
