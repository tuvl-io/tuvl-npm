/**
 * TuvlAuth — authentication helpers for @tuvl/client.
 *
 * Wraps the most common /auth/* endpoints (login, refresh, logout, who-am-I,
 * OAuth start, bootstrap) so consumers never have to manually construct
 * form-encoded bodies or manage Bearer headers for auth operations.
 *
 * A refused request rejects with {@link TuvlApiError}, as everywhere else in the client.
 *
 * Role membership (list roles, add or remove a member, disable a role) is in
 * {@link RolesClient} (`client.roles()`). The rest of the admin API (user and
 * role CRUD, scopes, federation config) is development-time work, done with
 * `tuvl iam` and the project's YAML, and is not wrapped.
 */

import { Transport } from "./transport";
import type { MeResponse, TokenResponse } from "./types";

export interface TuvlAuthOptions {
  /** Base URL of the tuvl server. Trailing slash is stripped automatically. */
  baseUrl: string;
}

export interface BootstrapRequest {
  email: string;
  password: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  /** Optional extra scope to grant the superadmin role on creation. */
  admin_scope?: string;
}

/** Per-call options for the auth helpers. */
export interface AuthCallOptions {
  signal?: AbortSignal;
}

export class TuvlAuth {
  private readonly transport: Transport;

  constructor(options: TuvlAuthOptions) {
    this.transport = new Transport({ baseUrl: options.baseUrl });
  }

  /**
   * Ask the server who the token belongs to: the user's identity, role
   * memberships (`groups`) and permission scopes.
   *
   * To just display them, `readToken(token)` reads the same claims locally.
   * `getMe` is the authoritative answer: it fails for a revoked token or a
   * user whose sessions were ended, which the token itself can't show.
   *
   * @throws {TuvlApiError} if the token is invalid, expired, or revoked.
   */
  getMe(token: string, options?: AuthCallOptions): Promise<MeResponse> {
    return this.transport.json<MeResponse>("GET", "/auth/me", { token, ...options });
  }

  /**
   * Exchange an email + password for an access token (an Ed25519-signed JWT).
   *
   * Calls `POST /auth/token` with an `application/x-www-form-urlencoded`
   * body (OAuth2 password-grant). The `username` field must be the user's
   * email address.
   */
  loginWithPassword(email: string, password: string, options?: AuthCallOptions): Promise<TokenResponse> {
    return this.transport.json<TokenResponse>("POST", "/auth/token", {
      form: new URLSearchParams({ username: email, password }),
      ...options,
    });
  }

  /**
   * Create the first superadmin user (one-time IAM bootstrap).
   *
   * Calls `POST /auth/bootstrap`. Returns 409 on every subsequent call
   * once any user exists.
   *
   * Only a server that mounts the `iam` API group answers: the dev server, or one with `iam` in
   * `spec.api.expose`. A production server (tuvl >= 2.1) does not, and replies 404; its first
   * administrator comes from `TUVL_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` or `tuvl iam`.
   */
  bootstrap(req: BootstrapRequest, options?: AuthCallOptions): Promise<TokenResponse> {
    return this.transport.json<TokenResponse>("POST", "/auth/bootstrap", { body: req, ...options });
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
   * - redirects to `TUVL_OAUTH_UI_REDIRECT_URL?token=<jwt>`, OR
   * - returns a JSON `{access_token, token_type}` body (CLI / server flows).
   */
  getOAuthLoginUrl(provider: string): string {
    return `${this.transport.baseUrl}/auth/oauth/${encodeURIComponent(provider)}/start`;
  }

  /**
   * Exchange a valid (non-expired, non-revoked) token for a fresh one.
   * The old token is immediately blacklisted — discard it after this call.
   */
  refresh(token: string, options?: AuthCallOptions): Promise<TokenResponse> {
    return this.transport.json<TokenResponse>("POST", "/auth/refresh", { token, ...options });
  }

  /**
   * Revoke the given token (logout). After this the token is blacklisted
   * across all workers that share a Redis instance. Resolves silently on
   * success (HTTP 204).
   */
  async logout(token: string, options?: AuthCallOptions): Promise<void> {
    await this.transport.send("POST", "/auth/logout", { token, ...options });
  }
}
