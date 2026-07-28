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

/** Opções das rotas de escrita (`create`, `update`, `delete`). */
export interface WriteOptions {
  /**
   * Escrever na hora em vez de enfileirar.
   *
   * Por padrão a API responde `202 { queued: true, jobId }` e o job roda no
   * BullMQ — a planilha só muda depois. Com `sync: true` ela escreve durante a
   * requisição e devolve a contagem (`{ created }` / `{ updated }` /
   * `{ deleted }`), ao custo de a requisição esperar o Google Sheets.
   */
  sync?: boolean;
}

export type { WriteResponse, MutationResponse, QueuedResponse } from '@sheets-banco/shared';

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
