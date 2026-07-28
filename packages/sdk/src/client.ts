import { SheetsBancoError, NetworkError } from './errors.js';
import type {
  SheetsBancoConfig,
  ReadOptions,
  SearchOptions,
  SheetRow,
  SheetRowCastNumbers,
  WriteOptions,
  WriteResponse,
} from './types.js';

export class SheetsBanco {
  private apiId: string;
  private baseUrl: string;
  private bearerToken?: string;

  constructor(config: SheetsBancoConfig) {
    this.apiId = config.apiId;
    this.baseUrl = (config.baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
    this.bearerToken = config.bearerToken;
  }

  private get endpoint(): string {
    return `${this.baseUrl}/api/v1/${this.apiId}`;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }
    return headers;
  }

  private buildQuery(params: { [key: string]: string | number | boolean | undefined }): string {
    const entries = Object.entries(params).filter(
      ([, v]) => v !== undefined && v !== false,
    );
    if (entries.length === 0) return '';
    const search = new URLSearchParams();
    for (const [k, v] of entries) {
      search.set(k, String(v));
    }
    return '?' + search.toString();
  }

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        headers: { ...this.buildHeaders(), ...options.headers as Record<string, string> },
      });
    } catch (err) {
      throw new NetworkError(
        err instanceof Error ? err.message : 'Network request failed',
      );
    }

    const data: any = await res.json();

    if (!res.ok) {
      throw new SheetsBancoError(
        res.status,
        data.code ?? 'UNKNOWN_ERROR',
        data.message ?? `Request failed with status ${res.status}`,
      );
    }

    return data as T;
  }

  /**
   * Lê as linhas da planilha.
   *
   * As sobrecargas existem porque `cast_numbers` muda o TIPO do que volta: sem
   * ele toda célula é string; com ele a API converte o que parece número. Um
   * retorno único `string | number` obrigaria todo mundo a estreitar mesmo no
   * caso padrão, em que nunca vem número.
   */
  async read(options?: ReadOptions & { cast_numbers?: false }): Promise<SheetRow[]>;
  async read(options: ReadOptions & { cast_numbers: true }): Promise<SheetRowCastNumbers[]>;
  async read(options: ReadOptions = {}): Promise<SheetRow[] | SheetRowCastNumbers[]> {
    const query = this.buildQuery(options as Record<string, string | number | boolean | undefined>);
    const result = await this.request<SheetRow[] | SheetRow>(this.endpoint + query);
    return Array.isArray(result) ? result : [result];
  }

  /**
   * Search rows with AND logic (all filters must match).
   */
  async search(
    filters: Record<string, string>,
    options: SearchOptions = {},
  ): Promise<SheetRow[]> {
    const query = this.buildQuery({ ...filters, ...options } as any);
    const result = await this.request<SheetRow[] | SheetRow>(
      this.endpoint + '/search' + query,
    );
    return Array.isArray(result) ? result : [result];
  }

  /**
   * Search rows with OR logic (any filter can match).
   */
  async searchOr(
    filters: Record<string, string>,
    options: SearchOptions = {},
  ): Promise<SheetRow[]> {
    const query = this.buildQuery({ ...filters, ...options } as any);
    const result = await this.request<SheetRow[] | SheetRow>(
      this.endpoint + '/search_or' + query,
    );
    return Array.isArray(result) ? result : [result];
  }

  /**
   * Cria uma ou mais linhas.
   *
   * **Por padrão a escrita é assíncrona**: a API enfileira o job e responde
   * `202 { queued: true, jobId }` sem ter tocado na planilha ainda. Passe
   * `{ sync: true }` para que ela escreva na hora e devolva `{ created }`.
   *
   * O retorno é união porque a resposta realmente muda de forma. Antes daqui
   * o método declarava `Promise<{ created: number }>` e nunca pedia o modo
   * síncrono — então `resultado.created` era `undefined` em tempo de execução
   * enquanto o TypeScript afirmava que era `number`, e um
   * `if (resultado.created > 0)` compilava e era sempre falso.
   *
   * Para estreitar: `if ('queued' in resultado) ... else ...`.
   */
  async create(
    data: SheetRow | SheetRow[],
    options: WriteOptions = {},
  ): Promise<WriteResponse> {
    return this.request(this.endpoint + this.buildQuery({ sync: options.sync }), {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }

  /**
   * Atualiza as linhas em que `column` é igual a `value`.
   *
   * Assíncrona por padrão — ver {@link SheetsBanco.create}.
   */
  async update(
    column: string,
    value: string,
    data: SheetRow,
    options: WriteOptions = {},
  ): Promise<WriteResponse> {
    const alvo = `${this.endpoint}/${encodeURIComponent(column)}/${encodeURIComponent(value)}`;
    return this.request(alvo + this.buildQuery({ sync: options.sync }), {
      method: 'PATCH',
      body: JSON.stringify({ data }),
    });
  }

  /**
   * Apaga as linhas em que `column` é igual a `value`.
   *
   * Assíncrona por padrão — ver {@link SheetsBanco.create}.
   */
  async delete(
    column: string,
    value: string,
    options: WriteOptions = {},
  ): Promise<WriteResponse> {
    const alvo = `${this.endpoint}/${encodeURIComponent(column)}/${encodeURIComponent(value)}`;
    return this.request(alvo + this.buildQuery({ sync: options.sync }), {
      method: 'DELETE',
    });
  }

  /**
   * Get column names (headers).
   */
  async keys(sheet?: string): Promise<string[]> {
    const query = sheet ? this.buildQuery({ sheet }) : '';
    return this.request(this.endpoint + '/keys' + query);
  }

  /**
   * Get row count.
   */
  async count(sheet?: string): Promise<{ rows: number }> {
    const query = sheet ? this.buildQuery({ sheet }) : '';
    return this.request(this.endpoint + '/count' + query);
  }
}
