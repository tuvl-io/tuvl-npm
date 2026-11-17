/**
 * Reading tuvl access tokens on the client.
 *
 * tuvl issues Ed25519-signed JWTs. Their claims are readable — not secret — so a UI can
 * show who is signed in and when to refresh without a round trip. Reading is **not**
 * verifying: never base an access decision on these claims in a client you don't
 * control. The server decides; `TuvlAuth.getMe()` asks it (and also sees logouts and
 * ended sessions, which the token itself can't show).
 */

/** The claims of a tuvl access token. */
export interface TokenClaims {
  /** Always `"tuvl"`. */
  iss: string;
  /** The user id. */
  sub: string;
  /** The user's IAM role names, e.g. `["hr_manager"]`. */
  groups: string[];
  /** The scopes those roles grant, e.g. `["candidate:read"]`. */
  scopes: string[];
  /** The tenant id, in multi-tenant deployments. */
  tenant?: string;
  /** Issued at, seconds since the epoch (millisecond precision). */
  iat: number;
  /** Expiry, seconds since the epoch; absent only when the server issues non-expiring tokens. */
  exp?: number;
  /** Unique token id. */
  jti?: string;
}

function decodeSegment(segment: string): unknown {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * The claims of a tuvl access token, **without verifying it**. Throws when the string
 * isn't a JWT carrying tuvl's claims: a payload that is not an object, no `sub` or `iat`,
 * `groups` or `scopes` that are not lists of strings, or an `exp` that is not a number.
 */
export function readToken(token: string): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a tuvl access token (expected a JWT)");
  let payload: unknown;
  try {
    payload = decodeSegment(parts[1]);
  } catch {
    throw new Error("not a tuvl access token (unreadable payload)");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("not a tuvl access token (the payload is not an object)");
  }
  const claims = payload as Partial<TokenClaims>;
  if (typeof claims.sub !== "string" || typeof claims.iat !== "number") {
    throw new Error("not a tuvl access token (missing sub/iat)");
  }
  for (const key of ["groups", "scopes"] as const) {
    const list: unknown = claims[key];
    if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === "string"))) {
      throw new Error(`not a tuvl access token (${key} is not a list of strings)`);
    }
  }
  if (claims.exp !== undefined && typeof claims.exp !== "number") {
    throw new Error("not a tuvl access token (exp is not a number)");
  }
  return { ...claims, groups: claims.groups ?? [], scopes: claims.scopes ?? [] } as TokenClaims;
}

/** When the token expires, or `null` for a non-expiring token. */
export function tokenExpiresAt(token: string): Date | null {
  const { exp } = readToken(token);
  return exp === undefined ? null : new Date(exp * 1000);
}

/**
 * Whether the token has expired, or will within `skewSeconds` (default 30) — the moment
 * to call `TuvlAuth.refresh()`.
 */
export function isTokenExpired(token: string, skewSeconds = 30, now: Date = new Date()): boolean {
  const expiresAt = tokenExpiresAt(token);
  return expiresAt !== null && expiresAt.getTime() - skewSeconds * 1000 <= now.getTime();
}
