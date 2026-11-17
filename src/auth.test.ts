/**
 * Tests for TuvlAuth — authentication helpers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TuvlAuth, readOAuthToken } from "./auth";
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

describe("setPassword", () => {
  const auth = new TuvlAuth({ baseUrl: "http://srv" });
  const link = "tok_".padEnd(40, "x");

  it("posts the link's token and the new password, as JSON, with no credentials of its own", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(auth.setPassword(link, "a-long-password-1")).resolves.toBeUndefined();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://srv/auth/password/set");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ token: link, password: "a-long-password-1" });
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBeUndefined();
  });

  it("rejects a link that is not valid (400) and a password the rule refuses (422), without echoing the password", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ detail: "This link is not valid or has expired" }, 400));
    await expect(auth.setPassword(link, "a-long-password-1")).rejects.toMatchObject({ status: 400, path: "/auth/password/set" });
    mockFetch.mockResolvedValueOnce(jsonResponse({ detail: "Password must be at least 8 characters" }, 422));
    const refused = await auth.setPassword(link, "short").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TuvlApiError);
    expect(refused).toMatchObject({ status: 422 });
    expect(String((refused as Error).message)).not.toContain("short\"");
  });

  it("can be cancelled", async () => {
    const controller = new AbortController();
    mockFetch.mockImplementationOnce(async (_url, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(null, { status: 204 });
    });
    controller.abort(new Error("stop"));
    await expect(auth.setPassword(link, "a-long-password-1", { signal: controller.signal })).rejects.toThrow("stop");
  });
});

describe("jwksUrl", () => {
  it("is where the server publishes its keys", () => {
    expect(new TuvlAuth({ baseUrl: "http://srv/" }).jwksUrl()).toBe("http://srv/auth/jwks.json");
  });
});

describe("readOAuthToken", () => {
  it("reads the token from the fragment the server redirects to", () => {
    expect(readOAuthToken({ url: "https://app.example.com/signed-in#token=abc.def.ghi" })).toBe("abc.def.ghi");
    expect(readOAuthToken({ url: new URL("https://app.example.com/#token=a%2Bb&x=1") })).toBe("a+b");
  });

  it("does not read the query string: a token there would have been logged", () => {
    expect(readOAuthToken({ url: "https://app.example.com/signed-in?token=abc.def.ghi" })).toBeUndefined();
  });

  it("is undefined when there is no token, an empty one, or no address", () => {
    expect(readOAuthToken({ url: "https://app.example.com/" })).toBeUndefined();
    expect(readOAuthToken({ url: "https://app.example.com/#token=" })).toBeUndefined();
    expect(readOAuthToken({ url: "https://app.example.com/#other=1" })).toBeUndefined();
    expect(readOAuthToken()).toBeUndefined(); // Node has no page
  });

  describe("in a browser", () => {
    const replaceState = vi.fn();
    beforeEach(() => {
      replaceState.mockReset();
      vi.stubGlobal("location", { href: "https://app.example.com/signed-in?from=login#token=abc.def.ghi" });
      vi.stubGlobal("history", { replaceState });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("reads the page's own address and leaves it alone unless told to clear it", () => {
      expect(readOAuthToken()).toBe("abc.def.ghi");
      expect(replaceState).not.toHaveBeenCalled();
    });

    it("takes the fragment out of the address bar and the history when asked, keeping the path and the query", () => {
      expect(readOAuthToken({ clear: true })).toBe("abc.def.ghi");
      expect(replaceState).toHaveBeenCalledWith(null, "", "/signed-in?from=login");
    });

    it("never rewrites the page's address for an address it was given", () => {
      expect(readOAuthToken({ url: "https://other.example.com/#token=zzz", clear: true })).toBe("zzz");
      expect(replaceState).not.toHaveBeenCalled();
    });
  });
});
