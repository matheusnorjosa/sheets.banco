export interface SheetRow {
  [key: string]: string;
}

export interface ApiResponse<T> {
  data: T;
}

export interface ApiErrorResponse {
  error: true;
  message: string;
  code: string;
  statusCode: number;
}

export interface CountResponse {
  rows: number;
}

export interface MutationResponse {
  created?: number;
  updated?: number;
  deleted?: number;
}
