const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

class ApiClient {
  private getToken(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("token");
  }

  setToken(token: string) {
    localStorage.setItem("token", token);
  }

  clearToken() {
    localStorage.removeItem("token");
  }

  isAuthenticated(): boolean {
    return !!this.getToken();
  }

  async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

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

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || "Request failed");
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
  async createApiKey(apiId: string, label?: string) {
    return this.fetch<{ apiKey: any }>(`/dashboard/apis/${apiId}/keys`, {
      method: "POST",
      body: JSON.stringify({ label }),
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
}

export const api = new ApiClient();
