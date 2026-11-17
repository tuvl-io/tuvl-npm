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
   * Set your own password with the one-time token of a set-password link (an administrator makes one with
   * `tuvl iam users invite`, or `POST /auth/admin/users/{id}/invite`). Public: the token is the credential. It works
   * once and expires, and the user's open sessions end. Resolves silently on success (HTTP 204); sign in afterwards with
   * {@link TuvlAuth.loginWithPassword}.
   *
   * @throws {TuvlApiError} 400 if the token is not valid (unknown, used or expired); 422 if the password breaks the
   * server's rule (8 characters at least, 72 bytes at most).
   */
  async setPassword(token: string, password: string, options?: AuthCallOptions): Promise<void> {
    await this.transport.send("POST", "/auth/password/set", { body: { token, password }, ...options });
  }

  /** Where the server publishes its signing keys (`GET /auth/jwks.json`), for a service that verifies tokens itself. */
  jwksUrl(): string {
    return `${this.transport.baseUrl}/auth/jwks.json`;
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
   * - redirects to `TUVL_OAUTH_UI_REDIRECT_URL#token=<jwt>` (the token is in the URL fragment, so it never reaches
   *   a server log; read it with `new URLSearchParams(location.hash.slice(1)).get("token")`), OR
   * - returns a JSON `{access_token, token_type}` body (CLI / server flows).
   *
   * Open the URL in the browser that will receive the callback: the server sets a short-lived cookie when the flow
   * starts and refuses a callback that arrives without it (tuvl >= 2.1).
   */
  getOAuthLoginUrl(provider: string): string {
    return `${this.transport.baseUrl}/auth/oauth/${encodeURIComponent(provider)}/start`;
  }

  /**
   * Exchange a valid (non-expired, non-revoked) token for a fresh one.
   * The old token is revoked at once, on every worker — discard it after this call.
   */
  refresh(token: string, options?: AuthCallOptions): Promise<TokenResponse> {
    return this.transport.json<TokenResponse>("POST", "/auth/refresh", { token, ...options });
  }

  /**
   * Revoke the given token (logout). After this every worker refuses it: the revocation is kept in Redis where the
   * server has a Redis datasource and in its database otherwise. Resolves silently on success (HTTP 204).
   */
  async logout(token: string, options?: AuthCallOptions): Promise<void> {
    await this.transport.send("POST", "/auth/logout", { token, ...options });
  }
}

/**
 * The token an OAuth sign-in left in the address of the page it sent the browser back to
 * (`https://app.example.com/signed-in#token=<jwt>`, the server's `TUVL_OAUTH_UI_REDIRECT_URL`). It is in the fragment so
 * that it never reaches a server log; this reads it from there. Undefined when the address has none.
 *
 * With no `url` it reads the page's own address, and `clear: true` then removes the fragment from the address bar and the
 * history (`history.replaceState`), so the token is not left lying around to be copied or shared. Read it once, store
 * it where your app keeps tokens, and call `client.setToken(token)`.
 */
export function readOAuthToken(options: { url?: string | URL; clear?: boolean } = {}): string | undefined {
  const href = options.url ?? globalThis.location?.href;
  if (href === undefined) return undefined;
  const url = new URL(String(href));
  const token = new URLSearchParams(url.hash.slice(1)).get("token") || undefined;
  if (token && options.clear && options.url === undefined) globalThis.history?.replaceState(null, "", `${url.pathname}${url.search}`);
  return token;
}
