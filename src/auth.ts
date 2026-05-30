/**
 * TuvlAuth — authentication helpers for @tuvl/client.
 *
 * Wraps the most common /auth/* endpoints (login, refresh, logout, who-am-I,
 * OAuth start, bootstrap) so consumers never have to manually construct
 * form-encoded bodies or manage Bearer headers for auth operations.
 *
 * Admin endpoints (user/role/scope CRUD, federation config) are NOT wrapped
 * — call them directly via `Transport` or `fetch` with the token.
 */

import type { MeResponse, TokenResponse } from "./types";

export interface TuvlAuthOptions {
  /** Base URL of the tuvl server. Trailing slash is stripped automatically. */
  baseUrl: string;
}

export interface BootstrapRequest {
  email: string;
  password: string;
  /** Optional extra scope to grant the superadmin role on creation. */
  admin_scope?: string;
}

export class TuvlAuth {
  private readonly baseUrl: string;

  constructor(options: TuvlAuthOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  /**
   * Decode the current token server-side and return the user's identity,
   * role memberships (`groups`), and permission scopes.
   *
   * Biscuit tokens are protobuf-encoded and cannot be decoded in pure JS,
   * so this is the correct way to read "who is logged in" and "what can
   * they do" from the TypeScript SDK.
   *
   * @throws if the token is invalid, expired, or revoked.
   */
  async getMe(token: string): Promise<MeResponse> {
    const response = await fetch(`${this.baseUrl}/auth/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`tuvl getMe failed (HTTP ${response.status}): ${text}`);
    }

    return response.json() as Promise<MeResponse>;
  }

  /**
   * Exchange an email + password for a Biscuit bearer token.
   *
   * Calls `POST /auth/token` with an `application/x-www-form-urlencoded`
   * body (OAuth2 password-grant). The `username` field must be the user's
   * email address.
   */
  async loginWithPassword(email: string, password: string): Promise<TokenResponse> {
    const body = new URLSearchParams({ username: email, password });

    const response = await fetch(`${this.baseUrl}/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`tuvl login failed (HTTP ${response.status}): ${text}`);
    }

    return response.json() as Promise<TokenResponse>;
  }

  /**
   * Create the first superadmin user (one-time IAM bootstrap).
   *
   * Calls `POST /auth/bootstrap`. Returns 409 on every subsequent call
   * once any user exists.
   */
  async bootstrap(req: BootstrapRequest): Promise<TokenResponse> {
    const response = await fetch(`${this.baseUrl}/auth/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(req),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`tuvl bootstrap failed (HTTP ${response.status}): ${text}`);
    }

    return response.json() as Promise<TokenResponse>;
  }

  /**
   * Return the URL the browser should navigate to in order to start an
   * OAuth2 login flow for the given provider.
   *
   * Supported built-ins: `"google"`, `"github"`, `"microsoft"`. Any
   * provider configured in the project's `federation/` directory also
   * works.
   *
   * After the OAuth dance the server either:
   * - redirects to `TUVL_OAUTH_UI_REDIRECT_URL?token=<biscuit_b64>`, OR
   * - returns a JSON `{access_token, token_type}` body (CLI / server flows).
   */
  getOAuthLoginUrl(provider: string): string {
    return `${this.baseUrl}/auth/oauth/${encodeURIComponent(provider)}/start`;
  }

  /**
   * Exchange a valid (non-expired, non-revoked) token for a fresh one.
   * The old token is immediately blacklisted — discard it after this call.
   */
  async refresh(token: string): Promise<TokenResponse> {
    const response = await fetch(`${this.baseUrl}/auth/refresh`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`tuvl token refresh failed (HTTP ${response.status}): ${text}`);
    }

    return response.json() as Promise<TokenResponse>;
  }

  /**
   * Revoke the given token (logout). After this the token is blacklisted
   * across all workers that share a Redis instance. Resolves silently on
   * success (HTTP 204).
   */
  async logout(token: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/auth/logout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(`tuvl logout failed (HTTP ${response.status}): ${text}`);
    }
  }
}
