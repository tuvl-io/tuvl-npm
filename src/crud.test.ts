/**
 * Tests for CrudClient and TuvlClient.crud() factory.
 *
 * Fetch is stubbed via vi.stubGlobal so no network calls are made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TuvlClient } from "./client";
import { CrudClient } from "./crud";
import { Transport } from "./transport";
import { TuvlApiError } from "./types";

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

interface Candidate {
  id: string;
  name: string;
  stage: string;
}

// ── CrudClient directly ────────────────────────────────────────────────────

describe("CrudClient", () => {
  function makeCrud() {
    const transport = new Transport({ baseUrl: "http://srv", defaultToken: "tok" });
    return new CrudClient<Candidate>(transport, "candidate");
  }

  // ── list() ──────────────────────────────────────────────────────────────

  describe("list()", () => {
    it("GETs /models/candidate/ with no options", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      const crud = makeCrud();
      const result = await crud.list();

      expect(result).toEqual([]);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/models/candidate/");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    });

    it("adds limit and offset query params", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      await makeCrud().list({ limit: 25, offset: 50 });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("limit=25");
      expect(url).toContain("offset=50");
    });

    it("serialises filters as filter[key]=value", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      await makeCrud().list({ filters: { stage: "screening", posting_id: "abc" } });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("filter%5Bstage%5D=screening");
      expect(url).toContain("filter%5Bposting_id%5D=abc");
    });

    it("serialises include as comma-joined ?include= param", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      await makeCrud().list({ include: ["posting", "assessments"] });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("include=posting%2Cassessments");
    });

    it("forwards per-call token override", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      await makeCrud().list({ token: "other-tok" });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer other-tok");
    });

    it("returns the parsed array", async () => {
      const rows: Candidate[] = [{ id: "1", name: "Alice", stage: "screening" }];
      mockFetch.mockResolvedValueOnce(jsonResponse(rows));
      const result = await makeCrud().list();
      expect(result).toEqual(rows);
    });
  });

  // ── get() ────────────────────────────────────────────────────────────────

  describe("get()", () => {
    it("GETs /models/candidate/{id}", async () => {
      const row: Candidate = { id: "abc-123", name: "Bob", stage: "interview" };
      mockFetch.mockResolvedValueOnce(jsonResponse(row));
      const result = await makeCrud().get("abc-123");

      expect(result).toEqual(row);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe("http://srv/models/candidate/abc-123");
    });

    it("URL-encodes the id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await makeCrud().get("id with spaces");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("id%20with%20spaces");
    });

    it("appends ?include= when include option is set", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await makeCrud().get("abc", { include: ["posting"] });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("include=posting");
    });

    it("throws on 404", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
      const error = await makeCrud().get("missing").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TuvlApiError);
      expect(error).toMatchObject({ status: 404, detail: "Not Found" });
      expect((error as Error).message).toContain("HTTP 404");
    });
  });

  // ── create() ─────────────────────────────────────────────────────────────

  describe("create()", () => {
    it("POSTs the body and returns the created record", async () => {
      const created: Candidate = { id: "new-id", name: "Carol", stage: "applied" };
      mockFetch.mockResolvedValueOnce(jsonResponse(created, 201));
      const result = await makeCrud().create({ name: "Carol", stage: "applied" } as Partial<Candidate>);

      expect(result).toEqual(created);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/models/candidate/");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ name: "Carol", stage: "applied" });
    });
  });

  // ── update() ─────────────────────────────────────────────────────────────

  describe("update()", () => {
    it("PATCHes the record and returns the updated resource", async () => {
      const updated: Candidate = { id: "abc-123", name: "Bob", stage: "offer" };
      mockFetch.mockResolvedValueOnce(jsonResponse(updated));
      const result = await makeCrud().update("abc-123", { stage: "offer" } as Partial<Candidate>);

      expect(result).toEqual(updated);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/models/candidate/abc-123");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string)).toEqual({ stage: "offer" });
    });

    it("throws on 404", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
      await expect(makeCrud().update("missing", {})).rejects.toThrow("HTTP 404");
    });
  });

  // ── delete() ─────────────────────────────────────────────────────────────

  describe("delete()", () => {
    it("sends DELETE to /models/candidate/{id} and resolves on 204", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(204));
      await expect(makeCrud().delete("abc-123")).resolves.toBeUndefined();

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://srv/models/candidate/abc-123");
      expect(init.method).toBe("DELETE");
    });

    it("throws on 404", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
      await expect(makeCrud().delete("missing")).rejects.toThrow("HTTP 404");
    });
  });
});

// ── TuvlClient.crud() factory ──────────────────────────────────────────────

describe("TuvlClient.crud()", () => {
  it("returns a CrudClient instance", () => {
    const client = new TuvlClient({ baseUrl: "http://srv", token: "tok" });
    const crud = client.crud("candidate");
    expect(crud).toBeInstanceOf(CrudClient);
  });

  it("uses lowercase model name in the path", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    const client = new TuvlClient({ baseUrl: "http://srv", token: "tok" });
    await client.crud("Candidate").list();

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("/models/candidate/");
  });

  it("shares the transport token with TuvlClient", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    const client = new TuvlClient({ baseUrl: "http://srv", token: "shared-tok" });
    await client.crud("candidate").list();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer shared-tok");
  });

  it("per-call token overrides the client-level token", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    const client = new TuvlClient({ baseUrl: "http://srv", token: "default" });
    await client.crud("candidate").list({ token: "override" });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer override");
  });
});
