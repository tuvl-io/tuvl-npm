/**
 * Tests for TuvlClient — orchestrates the REST and SSE transports.
 *
 * Fetch is stubbed via vi.stubGlobal so no network calls are made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TuvlClient } from "./client";
import { TuvlWorkflowError, TuvlWorkflowSuspendedError, type WorkflowManifest } from "./types";

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

function sseResponse(raw: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const baseManifest: WorkflowManifest = {
  name: "my-wf",
  trigger_path: "/api/workflows/my-wf/run",
  trigger_method: "POST",
  has_slow_steps: false,
  slow_kinds_present: [],
  steps: [],
};

// ── TuvlClient constructor ────────────────────────────────────────────────

describe("TuvlClient constructor", () => {
  it("strips trailing slash from baseUrl", () => {
    const c = new TuvlClient({ baseUrl: "http://localhost:8885/" });
    expect(c.baseUrl).toBe("http://localhost:8885");
  });
});

// ── Manifest ─────────────────────────────────────────────────────────────

describe("TuvlClient.getManifest()", () => {
  it("fetches and returns the manifest", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(baseManifest));
    const c = new TuvlClient({ baseUrl: "http://srv", token: "tok" });
    const m = await c.getManifest("my-wf");
    expect(m.name).toBe("my-wf");
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("http://srv/api/_system/workflows/my-wf");
  });

  it("returns cached manifest on second call", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(baseManifest));
    const c = new TuvlClient({ baseUrl: "http://srv", manifestCacheTtl: 60_000 });
    await c.getManifest("my-wf");
    await c.getManifest("my-wf");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(baseManifest)));
    const c = new TuvlClient({ baseUrl: "http://srv", manifestCacheTtl: 0 });
    await c.getManifest("my-wf");
    await c.getManifest("my-wf");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after invalidateManifest()", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(baseManifest)));
    const c = new TuvlClient({ baseUrl: "http://srv", manifestCacheTtl: 60_000 });
    await c.getManifest("my-wf");
    c.invalidateManifest("my-wf");
    await c.getManifest("my-wf");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("invalidateManifest() with no arg clears all cached entries", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(baseManifest)));
    const c = new TuvlClient({ baseUrl: "http://srv", manifestCacheTtl: 60_000 });
    await c.getManifest("wf-a");
    await c.getManifest("wf-b");
    c.invalidateManifest();
    await c.getManifest("wf-a");
    // 2 initial fetches + 1 re-fetch after invalidation = 3
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("URL-encodes the workflow name", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...baseManifest, name: "my wf" }));
    const c = new TuvlClient({ baseUrl: "http://srv" });
    await c.getManifest("my wf");
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("http://srv/api/_system/workflows/my%20wf");
  });

  it("passes through the public flag", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...baseManifest, public: true }));
    const c = new TuvlClient({ baseUrl: "http://srv" });
    const m = await c.getManifest("my-wf");
    expect(m.public).toBe(true);
  });
});

// ── execute() REST ────────────────────────────────────────────────────────

describe("TuvlClient.execute() — REST mode", () => {
  it("returns unwrapped data on success", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(baseManifest))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, status_code: 200, data: { answer: 42 }, error: null }),
      );

    const c = new TuvlClient({ baseUrl: "http://srv", token: "tok" });
    const result = await c.execute("my-wf");
    expect(result).toEqual({ answer: 42 });
  });

  it("forces REST when mode='rest' even with onProgress", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(baseManifest))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, status_code: 200, data: "done", error: null }),
      );

    const c = new TuvlClient({ baseUrl: "http://srv" });
    const steps: unknown[] = [];
    const result = await c.execute("my-wf", {
      mode: "rest",
      onProgress: (e) => steps.push(e),
    });
    expect(result).toBe("done");
    // second call should be a POST (not SSE)
    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe("application/json");
  });

  it("throws TuvlWorkflowError when success=false", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(baseManifest))
      .mockResolvedValueOnce(
        jsonResponse({
          success: false,
          status_code: 422,
          data: null,
          error: { code: "INVALID", message: "bad" },
        }),
      );

    const c = new TuvlClient({ baseUrl: "http://srv" });
    await expect(c.execute("my-wf")).rejects.toThrow(TuvlWorkflowError);
  });

  it("throws Error on HTTP transport error", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(baseManifest))
      .mockResolvedValueOnce(new Response("Server Error", { status: 500 }));

    const c = new TuvlClient({ baseUrl: "http://srv" });
    await expect(c.execute("my-wf")).rejects.toThrow("HTTP 500");
  });
});

// ── execute() SSE ─────────────────────────────────────────────────────────

describe("TuvlClient.execute() — SSE mode", () => {
  const slowManifest: WorkflowManifest = { ...baseManifest, has_slow_steps: true };

  it("uses SSE when mode='sse'", async () => {
    const sse = [
      "event: step",
      'data: {"step_id":"s1","kind":"llm","signal":"ok","snapshot":{},"duration_ms":10}',
      "",
      "event: done",
      'data: {"success":true,"data":{"out":1},"error":null}',
      "",
      "",
    ].join("\n");

    mockFetch
      .mockResolvedValueOnce(jsonResponse(baseManifest))
      .mockResolvedValueOnce(sseResponse(sse));

    const c = new TuvlClient({ baseUrl: "http://srv" });
    const steps: unknown[] = [];
    const result = await c.execute("my-wf", {
      mode: "sse",
      onProgress: (e) => steps.push(e),
    });
    expect(result).toEqual({ out: 1 });
    expect(steps).toHaveLength(1);
  });

  it("auto-upgrades to SSE when has_slow_steps=true and onProgress provided", async () => {
    const sse = [
      "event: done",
      'data: {"success":true,"data":"fast","error":null}',
      "",
      "",
    ].join("\n");

    mockFetch
      .mockResolvedValueOnce(jsonResponse(slowManifest))
      .mockResolvedValueOnce(sseResponse(sse));

    const c = new TuvlClient({ baseUrl: "http://srv" });
    const result = await c.execute("my-wf", { onProgress: () => {} });
    expect(result).toBe("fast");
    // Second fetch should be SSE (Accept: text/event-stream)
    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe("text/event-stream");
  });

  it("throws TuvlWorkflowError when SSE done event has success=false", async () => {
    const sse = [
      "event: done",
      'data: {"success":false,"data":null,"error":{"code":"ERR","message":"bad"}}',
      "",
      "",
    ].join("\n");

    mockFetch
      .mockResolvedValueOnce(jsonResponse(baseManifest))
      .mockResolvedValueOnce(sseResponse(sse));

    const c = new TuvlClient({ baseUrl: "http://srv" });
    await expect(c.execute("my-wf", { mode: "sse" })).rejects.toThrow(TuvlWorkflowError);
  });

  it("throws TuvlWorkflowSuspendedError when SSE emits suspended", async () => {
    const sse = [
      "event: suspended",
      'data: {"instance_id":"inst-1","paused_step_id":"review"}',
      "",
      "",
    ].join("\n");

    mockFetch
      .mockResolvedValueOnce(jsonResponse(baseManifest))
      .mockResolvedValueOnce(sseResponse(sse));

    const c = new TuvlClient({ baseUrl: "http://srv" });
    await expect(c.execute("my-wf", { mode: "sse" })).rejects.toThrow(
      TuvlWorkflowSuspendedError,
    );
  });

  it("throws Error when SSE emits error event", async () => {
    const sse = [
      "event: error",
      'data: {"message":"engine crashed","details":"OOM"}',
      "",
      "",
    ].join("\n");

    mockFetch
      .mockResolvedValueOnce(jsonResponse(baseManifest))
      .mockResolvedValueOnce(sseResponse(sse));

    const c = new TuvlClient({ baseUrl: "http://srv" });
    await expect(c.execute("my-wf", { mode: "sse" })).rejects.toThrow("engine crashed");
  });

  it("throws when SSE stream ends without a done event", async () => {
    const sse = [
      "event: step",
      'data: {"step_id":"s1","kind":"llm","signal":"ok","snapshot":{},"duration_ms":1}',
      "",
      "",
    ].join("\n");

    mockFetch
      .mockResolvedValueOnce(jsonResponse(baseManifest))
      .mockResolvedValueOnce(sseResponse(sse));

    const c = new TuvlClient({ baseUrl: "http://srv" });
    await expect(c.execute("my-wf", { mode: "sse" })).rejects.toThrow(
      "ended without a done event",
    );
  });
});

// ── executeVersioned() ────────────────────────────────────────────────────

describe("TuvlClient.executeVersioned()", () => {
  it("uses versioned trigger path", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(baseManifest)) // manifest fetch
      .mockResolvedValueOnce(
        jsonResponse({ success: true, status_code: 200, data: "v2result", error: null }),
      );

    const c = new TuvlClient({ baseUrl: "http://srv" });
    const result = await c.executeVersioned("my-wf", "v2");
    expect(result).toBe("v2result");

    const [url] = mockFetch.mock.calls[1] as [string];
    expect(url).toBe("http://srv/v2/run/my-wf");
  });

  it("falls back gracefully when manifest fetch fails", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("manifest 404")) // manifest fails
      .mockResolvedValueOnce(
        jsonResponse({ success: true, status_code: 200, data: "ok", error: null }),
      );

    const c = new TuvlClient({ baseUrl: "http://srv" });
    const result = await c.executeVersioned("my-wf", "v1");
    expect(result).toBe("ok");
  });
});

// ── resumeWorkflow() ──────────────────────────────────────────────────────

describe("TuvlClient.resumeWorkflow()", () => {
  it("POSTs to /api/workflows/resume with instance_id", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, status_code: 200, data: "resumed", error: null }),
    );

    const c = new TuvlClient({ baseUrl: "http://srv", token: "tok" });
    const result = await c.resumeWorkflow({ instanceId: "inst-1", humanInput: { ok: true } });
    expect(result).toBe("resumed");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://srv/api/workflows/resume");
    const body = JSON.parse(init.body as string);
    expect(body.instance_id).toBe("inst-1");
    expect(body.human_input).toEqual({ ok: true });
  });
});

// ── setToken() ────────────────────────────────────────────────────────────

describe("TuvlClient.setToken()", () => {
  it("updates the token used in subsequent calls", async () => {
    mockFetch.mockResolvedValue(jsonResponse(baseManifest));
    const c = new TuvlClient({ baseUrl: "http://srv", token: "old" });
    c.setToken("new");
    await c.getManifest("my-wf");
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer new");
  });
});
