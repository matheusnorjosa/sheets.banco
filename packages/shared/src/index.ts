/**
 * Contratos compartilhados entre a API, o SDK, o CLI e o dashboard.
 *
 * **Pacote type-only de propósito.** Não há um único valor exportado aqui — o
 * JS emitido é `export {};`. Quem consome usa `import type`, então a
 * importação some na compilação e não existe dependência em tempo de execução:
 * verificado que `@sheets-banco/shared` aparece só nos `.d.ts` do `dist`, nunca
 * nos `.js`.
 *
 * Isso importa porque o `main` deste pacote aponta para `src/index.ts` — TS
 * cru, sem passo de build. **Se alguém exportar um VALOR daqui** (uma função,
 * uma constante) e importá-lo, o `.js` compilado passa a ter um
 * `import ... from '@sheets-banco/shared'` de verdade, e o Node não consegue
 * carregar `.ts`. O `scripts/verifica-imports.mjs` do CI pega isso na hora,
 * porque importa cada módulo compilado com o Node de verdade — mas é bom saber
 * antes: para exportar valor daqui, primeiro é preciso dar um build ao pacote.
 *
 * Por que ele existe: até 2026-07-27 estas definições estavam duplicadas em
 * três lugares dentro da API e do SDK, e as cópias já tinham divergido em
 * silêncio (ver `SheetRow` abaixo). Uma fonte de verdade só ajuda se for a
 * fonte de verdade — antes deste ajuste, o pacote não era importado por
 * ninguém.
 */

/**
 * Uma linha da planilha como a API devolve **por padrão**: toda célula é
 * string, porque é isso que o Google Sheets entrega.
 *
 * É também o formato aceito na **escrita**: o schema de criação recusa valor
 * que não seja string (`{ quantidade: 42 }` dá 400; tem que ir `"42"`).
 */
export interface SheetRow {
  [coluna: string]: string;
}

/**
 * Uma linha lida com `?cast_numbers=true`, em que a API converte o que parece
 * número.
 *
 * Este tipo existe porque as três cópias antigas de `SheetRow` **não eram
 * idênticas**: a do SDK era `Record<string, string | number>` e a da API era
 * `{ [k: string]: string }`. Não era descuido de uma delas — elas descreviam
 * situações diferentes, e unificá-las num tipo só estaria errado nos dois
 * casos. Leitura casteada é mais larga que leitura padrão, e escrita é mais
 * estreita que as duas.
 */
export type SheetRowCastNumbers = Record<string, string | number>;

/** Resposta de leitura que embrulha o dado num envelope. */
export interface ApiResponse<T> {
  data: T;
}

/**
 * O envelope de erro que TODA resposta de erro da API usa
 * (`packages/api/src/lib/error-handler.ts`).
 *
 * `request_id` não é opcional por acaso: ele é ecoado no header
 * `X-Request-Id` e é o que liga o relato de um cliente à linha de log do
 * servidor (`docs/error-handling.md`). A versão antiga deste tipo declarava
 * só quatro campos e omitia justamente ele — e os três clientes o descartavam.
 */
export interface ApiErrorResponse {
  error: true;
  message: string;
  code: string;
  statusCode: number;
  request_id: string;
  /** Presente só em alguns códigos (ex.: `enable_url` no GOOGLE_API_NOT_ENABLED). */
  details?: Record<string, unknown>;
}

/** Resposta de `GET /:apiId/count`. */
export interface CountResponse {
  rows: number;
}

/**
 * Resposta de escrita em modo **síncrono** (`?sync=true`), em que a API
 * executa na hora e devolve quantas linhas mudaram.
 */
export interface MutationResponse {
  created?: number;
  updated?: number;
  deleted?: number;
}

/**
 * Resposta de escrita em modo **assíncrono**, que é o PADRÃO: a API enfileira
 * no BullMQ e responde 202 sem ter tocado na planilha ainda.
 *
 * Distinguir os dois no tipo importa: o SDK declarava só o formato síncrono e
 * nunca pedia `sync=true`, então `resultado.created` era `undefined` em runtime
 * enquanto o TypeScript afirmava que era `number`.
 */
export interface QueuedResponse {
  queued: true;
  jobId?: string;
  matchedRows?: number;
}

/**
 * O que uma rota de escrita pode devolver, nos dois modos.
 *
 * Para estreitar, use `'queued' in resposta` — a união é discriminada pela
 * presença da propriedade. Não há função-guarda exportada daqui de propósito:
 * exportar valor tiraria a propriedade type-only do pacote e obrigaria a um
 * passo de build e a uma dependência em tempo de execução.
 */
export type WriteResponse = MutationResponse | QueuedResponse;
