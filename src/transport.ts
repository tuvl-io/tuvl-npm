/**
 * Low-level HTTP transport for @tuvl/client.
 *
 * Handles auth header injection and JSON serialisation. `request` returns the raw
 * Response (for SSE and status-aware callers); the JSON helpers reject with
 * {@link TuvlApiError} when the server refuses.
 */

import { TuvlApiError } from "./types";

export interface TransportOptions {
  baseUrl: string;
  defaultToken?: string;
}

/** What the server said about a refusal: the `detail` of a JSON body, else the body, else its text. */
export async function detail(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && "detail" in parsed
      ? (parsed as { detail: unknown }).detail
      : parsed;
  } catch {
    return text;
  }
}

/** Seconds from a `Retry-After` header (a number of seconds or an HTTP date); undefined when it is absent or unreadable. */
export function retryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** The error for a refused request: what the server said and how long it asked the caller to wait. */
export async function refusal(response: Response, path: string): Promise<TuvlApiError> {
  return new TuvlApiError(response.status, await detail(response), path, retryAfter(response.headers));
}

/**
 * The JSON body of a successful response. A body that is not JSON (an HTML page from a proxy or a captive portal,
 * a wrong `baseUrl`) is a {@link TuvlApiError} that names the path and the content type, not a bare `SyntaxError`.
 */
export async function jsonBody(response: Response, path: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error; // an abort or a dropped connection is not this
    const kind = response.headers.get("content-type");
    throw new TuvlApiError(response.status, `the response is not JSON${kind ? ` (${kind})` : ""}`, path);
  }
}

type CallOptions = { token?: string; signal?: AbortSignal };

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

  /**
   * Send a request and return the raw Response without checking its status,
   * for callers that read status codes, headers or streams themselves.
   */
  async request(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      /** A multipart body (its content type, with the boundary, is set by `fetch`) or a form-encoded one. */
      form?: FormData | URLSearchParams;
      query?: Record<string, string | number | boolean | undefined>;
      accept?: string;
      token?: string;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: options?.accept ?? "application/json" };
    if (options?.body !== undefined && !options.form) headers["Content-Type"] = "application/json";
    if (options?.form instanceof URLSearchParams) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const auth = this.authHeader(options?.token);
    if (auth) headers.Authorization = auth;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return fetch(`${this.baseUrl}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers,
      body: options?.form ?? (options?.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal: options?.signal,
    });
  }

  private async checked(
    method: string,
    path: string,
    options?: Parameters<Transport["request"]>[2],
  ): Promise<Response> {
    const response = await this.request(method, path, options);
    if (!response.ok) throw await refusal(response, path);
    return response;
  }

  /** Send a request and return the parsed JSON body (`undefined` for 204). Rejects with {@link TuvlApiError}. */
  async json<T = unknown>(
    method: string,
    path: string,
    options?: Parameters<Transport["request"]>[2],
  ): Promise<T> {
    const response = await this.checked(method, path, options);
    return (response.status === 204 ? undefined : await jsonBody(response, path)) as T;
  }

  /** JSON GET. */
  get<TResponse = unknown>(path: string, options?: CallOptions): Promise<TResponse> {
    return this.json<TResponse>("GET", path, options);
  }

  /** JSON POST. */
  post<TBody = unknown, TResponse = unknown>(path: string, body: TBody, options?: CallOptions): Promise<TResponse> {
    return this.json<TResponse>("POST", path, { body, ...options });
  }

  /** JSON PATCH. */
  patch<TBody = unknown, TResponse = unknown>(path: string, body: TBody, options?: CallOptions): Promise<TResponse> {
    return this.json<TResponse>("PATCH", path, { body, ...options });
  }

  /** Send a request and discard the response body. Rejects with {@link TuvlApiError}. */
  async send(method: string, path: string, options?: Parameters<Transport["request"]>[2]): Promise<void> {
    await this.checked(method, path, options);
  }

  /** DELETE; the response body, if any, is ignored. */
  delete(path: string, options?: CallOptions): Promise<void> {
    return this.send("DELETE", path, options);
  }
}
