/**
 * Low-level HTTP transport for @tuvl/client.
 *
 * Handles auth header injection, JSON serialisation, and returns raw
 * Response objects so higher-level transports (SSE) can consume them.
 */

export interface TransportOptions {
  baseUrl: string;
  defaultToken?: string;
}

export class Transport {
  /** Public so callers can build raw URLs against the same server. */
  readonly baseUrl: string;
  private defaultToken: string | undefined;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.defaultToken = options.defaultToken;
  }

  /** Update the default token (e.g. after refresh). */
  setToken(token: string): void {
    this.defaultToken = token;
  }

  /** Build the Authorization header value, or undefined if no token. */
  private authHeader(overrideToken?: string): string | undefined {
    const tok = overrideToken ?? this.defaultToken;
    return tok ? `Bearer ${tok}` : undefined;
  }

  /** Perform a plain JSON POST and return the parsed response body. */
  async post<TBody = unknown, TResponse = unknown>(
    path: string,
    body: TBody,
    options?: { token?: string; signal?: AbortSignal },
  ): Promise<TResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const auth = this.authHeader(options?.token);
    if (auth) headers["Authorization"] = auth;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`tuvl POST ${path} → HTTP ${response.status}: ${text}`);
    }

    return response.json() as Promise<TResponse>;
  }

  /**
   * Send a request and return the raw Response without checking its status,
   * for callers that read status codes, headers or streams themselves.
   */
  async request(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      accept?: string;
      token?: string;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: options?.accept ?? "application/json" };
    if (options?.body !== undefined) headers["Content-Type"] = "application/json";
    const auth = this.authHeader(options?.token);
    if (auth) headers["Authorization"] = auth;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return fetch(`${this.baseUrl}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options?.signal,
    });
  }

  /** Simple GET returning parsed JSON. */
  async get<TResponse = unknown>(
    path: string,
    options?: { token?: string; signal?: AbortSignal },
  ): Promise<TResponse> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const auth = this.authHeader(options?.token);
    if (auth) headers["Authorization"] = auth;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers,
      signal: options?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`tuvl GET ${path} → HTTP ${response.status}: ${text}`);
    }

    return response.json() as Promise<TResponse>;
  }

  /** Perform a JSON PATCH and return the parsed response body. */
  async patch<TBody = unknown, TResponse = unknown>(
    path: string,
    body: TBody,
    options?: { token?: string; signal?: AbortSignal },
  ): Promise<TResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const auth = this.authHeader(options?.token);
    if (auth) headers["Authorization"] = auth;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`tuvl PATCH ${path} → HTTP ${response.status}: ${text}`);
    }

    return response.json() as Promise<TResponse>;
  }

  /** Perform a DELETE request. Expects a 204 No Content response. */
  async delete(
    path: string,
    options?: { token?: string; signal?: AbortSignal },
  ): Promise<void> {
    const headers: Record<string, string> = {};
    const auth = this.authHeader(options?.token);
    if (auth) headers["Authorization"] = auth;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers,
      signal: options?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`tuvl DELETE ${path} → HTTP ${response.status}: ${text}`);
    }
  }
}
