/**
 * TuvlAuth — authentication helpers for @tuvl/client.
 *
 * Wraps the tuvl server's /auth/* endpoints so consumers never have to
 * manually construct form-encoded bodies or manage Bearer headers for auth
 * operations.
 *
 * @example
 * ```ts
 * import { TuvlAuth, TuvlClient } from "@tuvl/client";
 *
 * const auth = new TuvlAuth({ baseUrl: "http://localhost:8000" });
 *
 * // Password login
 * const { access_token } = await auth.loginWithPassword("admin@example.com", "secret");
 *
 * // Use the token in the workflow client
 * const client = new TuvlClient({ baseUrl: "http://localhost:8000", token: access_token });
 *
 * // OAuth: redirect the browser to the provider login page
 * window.location.href = auth.getOAuthLoginUrl("google");
 * // After the callback the server redirects to TUVL_OAUTH_UI_REDIRECT_URL?token=<biscuit>
 * // Extract it and hand it to TuvlClient:
 * const token = new URLSearchParams(window.location.search).get("token")!;
 * const client2 = new TuvlClient({ baseUrl: "http://localhost:8000", token });
 * ```
 */

import type { TokenResponse } from "./types";

export interface TuvlAuthOptions {
  /** Base URL of the tuvl server. Trailing slash is stripped automatically. */
  baseUrl: string;
}

export class TuvlAuth {
  private readonly baseUrl: string;

  constructor(options: TuvlAuthOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  /**
   * Exchange an email + password for a Biscuit bearer token.
   *
   * Calls `POST /auth/token` with an `application/x-www-form-urlencoded` body
   * (OAuth2 password-grant format). The `username` field must be the user's
   * email address.
   *
   * @throws if the credentials are incorrect or the account is inactive.
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
   * Return the URL the browser should navigate (or be redirected) to in order
   * to start an OAuth2 login flow for the given provider.
   *
   * Supported built-in providers: `"google"`, `"github"`, `"microsoft"`.
   * Any provider configured in the `federation/` directory also works.
   *
   * After the OAuth dance completes the server will:
   * - Redirect the browser to `TUVL_OAUTH_UI_REDIRECT_URL?token=<biscuit_b64>`
   *   if that environment variable is set on the server.
   * - Return a JSON `{ access_token, token_type }` body otherwise (useful
   *   for server-side / CLI flows).
   *
   * @example
   * ```ts
   * // In a React component:
   * <button onClick={() => { window.location.href = auth.getOAuthLoginUrl("google"); }}>
   *   Login with Google
   * </button>
   *
   * // On the redirect page (TUVL_OAUTH_UI_REDIRECT_URL):
   * const token = new URLSearchParams(window.location.search).get("token")!;
   * const client = new TuvlClient({ baseUrl, token });
   * ```
   */
  getOAuthLoginUrl(provider: string): string {
    return `${this.baseUrl}/auth/oauth/${encodeURIComponent(provider)}/start`;
  }

  /**
   * Exchange a valid (non-expired, non-revoked) token for a fresh one.
   *
   * The old token is immediately blacklisted — discard it after this call.
   *
   * @throws if the current token is invalid, expired, or the user is inactive.
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
   * Revoke the given token (logout).
   *
   * After this call the token is blacklisted across all workers that share a
   * Redis instance. The caller should delete any stored copy of the token.
   *
   * Resolves silently on success (HTTP 204).
   *
   * @throws if the token is already invalid or the server returns an error.
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
