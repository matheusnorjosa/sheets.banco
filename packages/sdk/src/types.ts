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

export type SheetRow = Record<string, string | number>;
