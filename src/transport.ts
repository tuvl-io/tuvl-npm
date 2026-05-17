/**
 * Low-level HTTP transport for @tuvl/client.
 *
 * Handles auth header injection, JSON serialisation, and returns raw
 * Response objects so higher-level transports (SSE, gRPC) can consume them.
 */

export interface TransportOptions {
  baseUrl: string;
  defaultToken?: string;
}

export class Transport {
  private readonly baseUrl: string;
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
   * Open an SSE-capable stream and return the raw Response.
   * Callers are responsible for reading `response.body`.
   */
  async postStream(
    path: string,
    body: unknown,
    options?: { token?: string; signal?: AbortSignal },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
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
      throw new Error(`tuvl SSE ${path} → HTTP ${response.status}: ${text}`);
    }

    return response;
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
}
