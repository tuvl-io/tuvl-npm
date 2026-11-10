/**
 * Tests for TuvlAuth — authentication helpers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TuvlAuth } from "./auth";
import { TuvlApiError } from "./types";

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TuvlAuth", () => {
  describe("constructor", () => {
    it("strips trailing slash from baseUrl", () => {
      const auth = new TuvlAuth({ baseUrl: "http://localhost:8885/" });
      // Verify via getOAuthLoginUrl which uses the stored baseUrl
      expect(auth.getOAuthLoginUrl("google")).toBe(
        "http://localhost:8885/auth/oauth/google/start",
      );
    });
  });

  describe("getMe()", () => {
    it("returns MeResponse on success", async () => {
      const me = { user_id: "u1", groups: ["admin"], scopes: ["candidate:read"] };
      mockFetch.mockResolvedValueOnce(jsonResponse(me));

      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      const result = await auth.getMe("tok");

      expect(result).toEqual(me);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/auth/me");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      await expect(auth.getMe("bad")).rejects.toThrow("HTTP 401");
    });
  });

  describe("loginWithPassword()", () => {
    it("sends form-encoded body and returns token", async () => {
      const token = { access_token: "abc", token_type: "bearer" };
      mockFetch.mockResolvedValueOnce(jsonResponse(token));

      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      const result = await auth.loginWithPassword("user@example.com", "pass");

      expect(result).toEqual(token);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/auth/token");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(init.body?.toString()).toContain("username=user%40example.com");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(new Response("wrong password", { status: 401 }));
      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      await expect(auth.loginWithPassword("u", "p")).rejects.toThrow("HTTP 401");
    });
  });

  describe("bootstrap()", () => {
    it("calls /auth/bootstrap with JSON body", async () => {
      const token = { access_token: "xyz", token_type: "bearer" };
      mockFetch.mockResolvedValueOnce(jsonResponse(token));

      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      const result = await auth.bootstrap({ email: "admin@example.com", password: "pass" });

      expect(result).toEqual(token);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/auth/bootstrap");
      expect(JSON.parse(init.body as string)).toMatchObject({ email: "admin@example.com" });
    });

    it("throws on 409 conflict (already bootstrapped)", async () => {
      mockFetch.mockResolvedValueOnce(new Response("exists", { status: 409 }));
      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      await expect(
        auth.bootstrap({ email: "a@b.com", password: "p" }),
      ).rejects.toThrow("HTTP 409");
    });
  });

  describe("getOAuthLoginUrl()", () => {
    it("returns the correct OAuth start URL", () => {
      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      expect(auth.getOAuthLoginUrl("github")).toBe("http://srv/auth/oauth/github/start");
    });

    it("URL-encodes the provider name", () => {
      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      expect(auth.getOAuthLoginUrl("my provider")).toBe(
        "http://srv/auth/oauth/my%20provider/start",
      );
    });
  });

  describe("refresh()", () => {
    it("sends Bearer token and returns new token", async () => {
      const newToken = { access_token: "new", token_type: "bearer" };
      mockFetch.mockResolvedValueOnce(jsonResponse(newToken));

      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      const result = await auth.refresh("old-tok");

      expect(result).toEqual(newToken);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/auth/refresh");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer old-tok");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(new Response("expired", { status: 401 }));
      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      await expect(auth.refresh("tok")).rejects.toThrow("HTTP 401");
    });
  });

  describe("logout()", () => {
    it("calls /auth/logout and resolves on 204", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      await expect(auth.logout("tok")).resolves.toBeUndefined();

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/auth/logout");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(new Response("error", { status: 500 }));
      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      await expect(auth.logout("tok")).rejects.toThrow("HTTP 500");
    });
  });

  describe("errors", () => {
    it("reject with a TuvlApiError, as the rest of the client does", async () => {
      const auth = new TuvlAuth({ baseUrl: "http://srv" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ detail: "Incorrect email or password" }, 401));
      const error = await auth.loginWithPassword("u", "p").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TuvlApiError);
      expect(error).toMatchObject({ status: 401, detail: "Incorrect email or password", path: "/auth/token" });

      mockFetch.mockResolvedValueOnce(new Response("down", { status: 503 }));
      await expect(auth.getMe("tok")).rejects.toBeInstanceOf(TuvlApiError);
      mockFetch.mockResolvedValueOnce(new Response("down", { status: 503 }));
      await expect(auth.logout("tok")).rejects.toBeInstanceOf(TuvlApiError);
    });
  });

  describe("signal", () => {
    it("is passed to fetch", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ user_id: "u1" }));
      const controller = new AbortController();
      await new TuvlAuth({ baseUrl: "http://srv" }).getMe("tok", { signal: controller.signal });
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBe(controller.signal);
    });
  });

  describe("logout() with a body", () => {
    it("ignores a body on success", async () => {
      mockFetch.mockResolvedValueOnce(new Response("ok", { status: 200 }));
      await expect(new TuvlAuth({ baseUrl: "http://srv" }).logout("tok")).resolves.toBeUndefined();
    });
  });
});
