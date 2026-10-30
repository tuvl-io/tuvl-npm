/**
 * Tests for Transport — low-level HTTP layer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Transport } from "./transport";

// Vitest provides globalThis.fetch; we spy on it per-test.
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

function errorResponse(status: number, text = "bad request"): Response {
  return new Response(text, { status });
}

describe("Transport", () => {
  describe("constructor", () => {
    it("strips trailing slash from baseUrl", () => {
      const t = new Transport({ baseUrl: "http://localhost:8885/" });
      expect(t.baseUrl).toBe("http://localhost:8885");
    });

    it("preserves baseUrl without trailing slash", () => {
      const t = new Transport({ baseUrl: "http://localhost:8885" });
      expect(t.baseUrl).toBe("http://localhost:8885");
    });
  });

  describe("post()", () => {
    it("sends JSON body and returns parsed response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      const t = new Transport({ baseUrl: "http://srv", defaultToken: "tok" });
      const result = await t.post("/api/run", { payload: 1 });
      expect(result).toEqual({ ok: true });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/api/run");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });

    it("uses override token over default token", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      const t = new Transport({ baseUrl: "http://srv", defaultToken: "default" });
      await t.post("/path", {}, { token: "override" });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer override");
    });

    it("omits Authorization header when no token is set", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      const t = new Transport({ baseUrl: "http://srv" });
      await t.post("/path", {});

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    });

    it("throws on non-OK HTTP status", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(422, "Unprocessable"));
      const t = new Transport({ baseUrl: "http://srv" });
      await expect(t.post("/path", {})).rejects.toThrow("HTTP 422");
    });
  });

  describe("get()", () => {
    it("sends GET and returns parsed JSON", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([1, 2, 3]));
      const t = new Transport({ baseUrl: "http://srv", defaultToken: "t" });
      const result = await t.get("/items");
      expect(result).toEqual([1, 2, 3]);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/items");
      expect((init as RequestInit).method).toBe("GET");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, "Not Found"));
      const t = new Transport({ baseUrl: "http://srv" });
      await expect(t.get("/missing")).rejects.toThrow("HTTP 404");
    });
  });

  describe("request()", () => {
    it("returns the raw Response with query, body and auth", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(503));
      const t = new Transport({ baseUrl: "http://srv/", defaultToken: "t" });
      const response = await t.request("POST", "/x", { body: { a: 1 }, query: { wait: false, skip: undefined } });

      expect(response.status).toBe(503); // not thrown: the caller reads the status
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/x?wait=false");
      expect(init.body).toBe('{"a":1}');
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer t");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });

    it("sends no body or content type for a GET", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      const t = new Transport({ baseUrl: "http://srv" });
      await t.request("GET", "/runs", { accept: "text/event-stream" });
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>)["Accept"]).toBe("text/event-stream");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    });
  });

  describe("setToken()", () => {
    it("updates the default token used for subsequent requests", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      const t = new Transport({ baseUrl: "http://srv", defaultToken: "old" });
      t.setToken("new");
      await t.post("/path", {});

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer new");
    });
  });
});
