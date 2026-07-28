/**
 * `??`, não `||`.
 *
 * Com `||`, uma `NEXT_PUBLIC_API_URL` declarada-mas-VAZIA na Vercel (fácil de
 * acontecer ao criar a variável e esquecer o valor) caía no fallback e fazia o
 * dashboard de **produção** apontar para o `localhost` de quem abrisse o
 * navegador. Em silêncio: a tela carrega, as chamadas falham por conexão
 * recusada, e nada indica a causa.
 *
 * Com `??` só `undefined` cai no fallback — string vazia continua string
 * vazia, as chamadas viram caminho relativo e a falha aponta para a
 * configuração.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

/**
 * Erro que o dashboard lança quando a API responde com falha.
 *
 * Antes era `new Error(message)`: `code` e `request_id` do envelope eram
 * descartados. O `request_id` é justamente o que liga a tela ao log da API —
 * sem ele, um relato de tela não tem como ser rastreado do outro lado.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

class ApiClient {
  private getToken(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("token");
  }

  setToken(token: string) {
    localStorage.setItem("token", token);
  }

  clearToken() {
    // Mesma guarda do `getToken`. Sem ela, um 401 durante render no servidor
    // estourava aqui ("localStorage is not defined") e o erro que aparecia não
    // tinha relação com a causa — o `setToken` tem o mesmo risco, mas só é
    // chamado a partir de evento do usuário.
    if (typeof window === "undefined") return;
    localStorage.removeItem("token");
  }

  isAuthenticated(): boolean {
    return !!this.getToken();
  }

  async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    if (options.body !== undefined && options.body !== null) {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    }

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      this.clearToken();
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
      throw new Error("Unauthorized");
    }

    const text = await res.text();

    // O `JSON.parse` solto estourava um `SyntaxError` sempre que a resposta não
    // era JSON: HTML de gateway (502/504 da Vercel, do Render ou de proxy
    // corporativo), página de manutenção, corpo truncado. A tela mostrava
    // "Unexpected token <", que não diz nem o status nem o que aconteceu.
    let data: { message?: string; code?: string; request_id?: string } | null = null;
    if (text.trim().length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        const trecho = text.trim().replace(/\s+/g, " ").slice(0, 80);
        throw new ApiError(
          res.status,
          "INVALID_RESPONSE",
          `A resposta (HTTP ${res.status}) não é JSON válido: ${trecho}`,
        );
      }
    }

    if (!res.ok) {
      throw new ApiError(
        res.status,
        data?.code ?? "UNKNOWN_ERROR",
        data?.message ?? `Request failed (${res.status})`,
        // Fallback no header porque nem toda resposta de erro da API passa pelo
        // error handler — há 31 pontos que respondem direto, sem `request_id`
        // no corpo, mas o header sai do mesmo jeito quando o handler atua.
        data?.request_id ?? res.headers.get("x-request-id") ?? undefined,
      );
    }

    return data as T;
  }

  // Auth
  async register(email: string, password: string, name?: string) {
    return this.fetch<{ user: any; token: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    });
  }

  async login(email: string, password: string) {
    return this.fetch<{ user: any; token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }

  async getMe() {
    return this.fetch<{ user: any }>("/auth/me");
  }

  /**
   * URL da tela de consentimento do Google para "conectar minha conta".
   *
   * O token de sessão vai no header, como em qualquer outra chamada. Antes o
   * dashboard navegava direto para `/auth/google?token=<JWT>`, o que punha a
   * sessão no histórico do navegador e no log de acesso de todo intermediário.
   */
  async googleAuthUrl() {
    return this.fetch<{ url: string }>("/auth/google/url", { method: "POST" });
  }

  /**
   * Troca o código de 60s que veio em `/callback?code=` por uma sessão.
   */
  async exchangeGoogleCode(code: string) {
    return this.fetch<{ user: any; token: string }>("/auth/google/exchange", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  }

  // Dashboard APIs
  async listApis() {
    return this.fetch<{ apis: any[] }>("/dashboard/apis");
  }

  async createApi(name: string, spreadsheetUrl: string) {
    return this.fetch<{ api: any }>("/dashboard/apis", {
      method: "POST",
      body: JSON.stringify({ name, spreadsheetUrl }),
    });
  }

  async getApi(id: string) {
    return this.fetch<{ api: any }>(`/dashboard/apis/${id}`);
  }

  async updateApi(id: string, data: Record<string, any>) {
    return this.fetch<{ api: any }>(`/dashboard/apis/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async deleteApi(id: string) {
    return this.fetch<{ deleted: boolean }>(`/dashboard/apis/${id}`, {
      method: "DELETE",
    });
  }

  // API Keys
  //
  // The plaintext key comes back on this response and nowhere else — GET
  // /dashboard/apis/:id only returns the prefix. Callers must surface it to the
  // user immediately; there is no way to read it again.
  async createApiKey(
    apiId: string,
    opts?: { label?: string; scopes?: string[]; expiresAt?: string | null }
  ) {
    return this.fetch<{
      apiKey: {
        id: string;
        key: string;
        keyPrefix: string | null;
        label: string | null;
        active: boolean;
        scopes: string[];
        expiresAt: string | null;
        createdAt: string;
      };
      apiIsPublic: boolean;
    }>(`/dashboard/apis/${apiId}/keys`, {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    });
  }

  async deleteApiKey(apiId: string, keyId: string) {
    return this.fetch<{ deleted: boolean }>(
      `/dashboard/apis/${apiId}/keys/${keyId}`,
      { method: "DELETE" }
    );
  }

  // Usage
  async getUsage(apiId: string, days = 7) {
    return this.fetch<{ total: number; days: number; recent: any[] }>(
      `/dashboard/apis/${apiId}/usage?days=${days}`
    );
  }

  async getUsageChart(apiId: string, days = 7) {
    return this.fetch<{
      timeline: { date: string; requests: number; avgMs: number }[];
      methods: { method: string; count: number }[];
      statuses: { status: string; count: number }[];
      total: number;
    }>(`/dashboard/apis/${apiId}/usage/chart?days=${days}`);
  }

  // Computed Fields
  async listComputedFields(apiId: string) {
    return this.fetch<{ fields: any[] }>(`/dashboard/apis/${apiId}/computed-fields`);
  }

  async createComputedField(apiId: string, name: string, expression: string) {
    return this.fetch<{ field: any }>(`/dashboard/apis/${apiId}/computed-fields`, {
      method: "POST",
      body: JSON.stringify({ name, expression }),
    });
  }

  async updateComputedField(apiId: string, fieldId: string, expression: string) {
    return this.fetch<{ field: any }>(
      `/dashboard/apis/${apiId}/computed-fields/${fieldId}`,
      { method: "PATCH", body: JSON.stringify({ expression }) }
    );
  }

  async deleteComputedField(apiId: string, fieldId: string) {
    return this.fetch<{ deleted: boolean }>(
      `/dashboard/apis/${apiId}/computed-fields/${fieldId}`,
      { method: "DELETE" }
    );
  }

  // Snapshots
  async listSnapshots(apiId: string) {
    return this.fetch<{ snapshots: any[] }>(`/dashboard/apis/${apiId}/snapshots`);
  }

  async createSnapshot(apiId: string, sheet?: string) {
    const qs = sheet ? `?sheet=${encodeURIComponent(sheet)}` : "";
    return this.fetch<{ snapshot: any }>(`/dashboard/apis/${apiId}/snapshots${qs}`, {
      method: "POST",
    });
  }

  async getSnapshot(apiId: string, version: number) {
    return this.fetch<{ snapshot: any }>(
      `/dashboard/apis/${apiId}/snapshots/${version}`
    );
  }

  async deleteSnapshot(apiId: string, version: number) {
    return this.fetch<{ deleted: boolean }>(
      `/dashboard/apis/${apiId}/snapshots/${version}`,
      { method: "DELETE" }
    );
  }

  // Scheduled Sync
  async getSyncSettings(apiId: string) {
    return this.fetch<{ sync: any }>(`/dashboard/apis/${apiId}/sync`);
  }

  async updateSyncSettings(apiId: string, data: { syncEnabled: boolean; syncCron?: string | null }) {
    return this.fetch<{ sync: any }>(`/dashboard/apis/${apiId}/sync`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async triggerSync(apiId: string) {
    return this.fetch<{ triggered: boolean; message: string }>(
      `/dashboard/apis/${apiId}/sync/trigger`,
      { method: "POST" }
    );
  }

  // Multi-spreadsheet
  async listSpreadsheets(apiId: string) {
    return this.fetch<{ primary: any; additional: any[] }>(
      `/dashboard/apis/${apiId}/spreadsheets`
    );
  }

  async addSpreadsheet(apiId: string, spreadsheetUrl: string, label: string) {
    return this.fetch<{ sheet: any }>(`/dashboard/apis/${apiId}/spreadsheets`, {
      method: "POST",
      body: JSON.stringify({ spreadsheetUrl, label }),
    });
  }

  async removeSpreadsheet(apiId: string, sheetId: string) {
    return this.fetch<{ deleted: boolean }>(
      `/dashboard/apis/${apiId}/spreadsheets/${sheetId}`,
      { method: "DELETE" }
    );
  }
}

export const api = new ApiClient();
