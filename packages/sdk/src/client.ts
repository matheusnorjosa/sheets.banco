import { SheetsBancoError, NetworkError } from './errors.js';
import type { SheetsBancoConfig, ReadOptions, SearchOptions, SheetRow } from './types.js';

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
   * Read all rows from the sheet.
   */
  async read(options: ReadOptions = {}): Promise<SheetRow[]> {
    const query = this.buildQuery(options as any);
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
   * Create one or more rows.
   */
  async create(data: Record<string, string> | Record<string, string>[]): Promise<{ created: number }> {
    return this.request(this.endpoint, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }

  /**
   * Update rows where `column` equals `value`.
   */
  async update(
    column: string,
    value: string,
    data: Record<string, string>,
  ): Promise<{ updated: number }> {
    return this.request(`${this.endpoint}/${encodeURIComponent(column)}/${encodeURIComponent(value)}`, {
      method: 'PATCH',
      body: JSON.stringify({ data }),
    });
  }

  /**
   * Delete rows where `column` equals `value`.
   */
  async delete(column: string, value: string): Promise<{ deleted: number }> {
    return this.request(`${this.endpoint}/${encodeURIComponent(column)}/${encodeURIComponent(value)}`, {
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
