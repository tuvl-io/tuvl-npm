import { describe, expect, it } from "vitest";
import { isTokenExpired, readToken, tokenExpiresAt } from "./token";

const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "EdDSA", typ: "JWT", kid: "k1" })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

const raw = (payload: unknown) => `${b64url({ alg: "EdDSA", typ: "JWT" })}.${b64url(payload)}.c2lnbmF0dXJl`;

const base = { iss: "tuvl", sub: "3f6c-uuid", groups: ["reviewers"], scopes: ["approvals:decide"], iat: 1760000000.123 };

describe("readToken", () => {
  it("returns the claims of a tuvl access token", () => {
    const claims = readToken(jwt({ ...base, exp: 1760086400, tenant: "acme", jti: "abc" }));
    expect(claims).toMatchObject({ sub: "3f6c-uuid", groups: ["reviewers"], scopes: ["approvals:decide"], tenant: "acme", exp: 1760086400 });
  });

  it("decodes UTF-8 claims and base64url payloads", () => {
    const claims = readToken(jwt({ ...base, sub: "user-ñ-✓", groups: ["équipe/ops?"] }));
    expect(claims.sub).toBe("user-ñ-✓");
    expect(claims.groups).toEqual(["équipe/ops?"]);
  });

  it("defaults missing groups and scopes to empty lists", () => {
    const { iss, sub, iat } = base;
    expect(readToken(jwt({ iss, sub, iat }))).toMatchObject({ groups: [], scopes: [] });
  });

  it.each([
    ["not-a-jwt", /expected a JWT/],
    ["a.b", /expected a JWT/],
    ["e30.%%%.sig", /unreadable payload/],
    [jwt({ iss: "tuvl", groups: [] }), /missing sub\/iat/],
  ])("refuses %s", (token, message) => {
    expect(() => readToken(token)).toThrow(message);
  });
});

describe("readToken checks the shape of the claims", () => {
  it.each([
    ["a null payload", raw(null), /payload is not an object/],
    ["a list as payload", raw([1, 2]), /payload is not an object/],
    ["a string as payload", raw("hello"), /payload is not an object/],
    ["groups as a string", jwt({ ...base, groups: "reviewers" }), /groups is not a list of strings/],
    ["a number among the groups", jwt({ ...base, groups: ["a", 1] }), /groups is not a list of strings/],
    ["scopes as a string", jwt({ ...base, scopes: "approvals:decide" }), /scopes is not a list of strings/],
    ["a text exp", jwt({ ...base, exp: "tomorrow" }), /exp is not a number/],
    ["a null exp", jwt({ ...base, exp: null }), /exp is not a number/],
  ])("refuses %s", (_name, token, message) => {
    expect(() => readToken(token)).toThrow(message);
  });

  it("no longer reads a token with a text exp as one that never expires", () => {
    expect(() => isTokenExpired(jwt({ ...base, exp: "never" }))).toThrow(/exp is not a number/);
  });
});

describe("expiry helpers", () => {
  const now = new Date(1760000000 * 1000);

  it("reports the expiry, or null for a non-expiring token", () => {
    expect(tokenExpiresAt(jwt({ ...base, exp: 1760003600 }))?.toISOString()).toBe(new Date(1760003600 * 1000).toISOString());
    expect(tokenExpiresAt(jwt(base))).toBeNull();
  });

  it("is expired once within the skew of exp", () => {
    expect(isTokenExpired(jwt({ ...base, exp: 1760003600 }), 30, now)).toBe(false);
    expect(isTokenExpired(jwt({ ...base, exp: 1760000020 }), 30, now)).toBe(true);
    expect(isTokenExpired(jwt({ ...base, exp: 1759999999 }), 0, now)).toBe(true);
    expect(isTokenExpired(jwt(base), 30, now)).toBe(false);
  });
});
