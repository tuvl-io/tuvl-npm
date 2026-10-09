/**
 * TuvlClient 2.0 against a stubbed fetch: runs, handles, events, approvals.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunHandle, TuvlClient } from "./client";
import { TuvlApiError, TuvlRunError, type Run } from "./types";

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "r1",
    workflow: "greet",
    status: "running",
    trigger: "api",
    current_agent: null,
    end: null,
    output: null,
    error: null,
    tokens_used: 0,
    created_at: null,
    updated_at: null,
    status_url: "/api/runs/r1",
    events_url: "/api/runs/r1/events",
    ...overrides,
  };
}

type Workflows = {
  greet: { input: { name: string }; output: { text: string } };
};

const client = () => new TuvlClient<Workflows>({ baseUrl: "http://srv/", token: "tok" });

function call(n = 0): { url: string; init: RequestInit } {
  const [url, init] = mockFetch.mock.calls[n] as [string, RequestInit];
  return { url, init };
}

describe("execute()", () => {
  it("posts the input and resolves the end's body", async () => {
    mockFetch.mockResolvedValueOnce(json({ text: "hello ada" }, 201, { "x-tuvl-run-id": "r1" }));
    const out = await client().execute("greet", { name: "ada" });
    expect(out).toEqual({ text: "hello ada" });
    const { url, init } = call();
    expect(url).toBe("http://srv/api/workflows/greet/runs?wait=true");
    expect(JSON.parse(String(init.body))).toEqual({ input: { name: "ada" } });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("resolves a RunHandle on 202", async () => {
    mockFetch.mockResolvedValueOnce(json(run({ status: "waiting_human" }), 202, { "x-tuvl-run-id": "r1" }));
    const out = await client().execute("greet", { name: "ada" });
    expect(out).toBeInstanceOf(RunHandle);
    expect((out as RunHandle).id).toBe("r1");
    expect((out as RunHandle).run?.status).toBe("waiting_human");
  });

  it("rejects an error end with TuvlRunError and a refusal with TuvlApiError", async () => {
    mockFetch.mockResolvedValueOnce(json({ error: "no" }, 422, { "x-tuvl-run-id": "r9" }));
    const failed = await client().execute("greet", { name: "x" }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(TuvlRunError);
    expect(failed).toMatchObject({ status: 422, body: { error: "no" }, runId: "r9" });

    mockFetch.mockResolvedValueOnce(json({ detail: [{ loc: ["name"], msg: "bad" }] }, 422));
    const refused = await client().execute("greet", { name: "x" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TuvlApiError);
    expect(refused).toMatchObject({ status: 422, detail: [{ loc: ["name"], msg: "bad" }] });
  });

  it("start() does not wait", async () => {
    mockFetch.mockResolvedValueOnce(json(run({ status: "queued" }), 202, { "x-tuvl-run-id": "r1" }));
    const handle = await client().start("greet", { name: "ada" });
    expect(handle.id).toBe("r1");
    expect(call().url).toContain("wait=false");
  });
});

describe("RunHandle", () => {
  it("wait() polls until the run ends and returns its output", async () => {
    mockFetch
      .mockResolvedValueOnce(json(run({ status: "running" })))
      .mockResolvedValueOnce(json(run({ status: "completed", output: { status: 201, body: { text: "hi" } } })));
    const out = await client().run<{ text: string }>("r1").wait({ intervalMs: 1 });
    expect(out).toEqual({ text: "hi" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("wait() rejects failures and error ends; untilWaiting stops at a person", async () => {
    mockFetch.mockResolvedValueOnce(json(run({ status: "failed", error: "kaboom" })));
    await expect(client().run("r1").wait()).rejects.toBeInstanceOf(TuvlRunError);
    mockFetch.mockResolvedValueOnce(json(run({ status: "completed", output: { status: 409, body: "no" } })));
    await expect(client().run("r1").wait()).rejects.toMatchObject({ status: 409, body: "no" });
    mockFetch.mockResolvedValueOnce(json(run({ status: "waiting_approval" })));
    expect(await client().run("r1").wait({ untilWaiting: true })).toBeUndefined();
  });

  it("wait() times out", async () => {
    mockFetch.mockImplementation(async () => json(run({ status: "running" })));
    await expect(client().run("r1").wait({ intervalMs: 5, timeoutMs: 1 })).rejects.toThrow("still running");
  });

  it("controls the run", async () => {
    mockFetch.mockImplementation(async () => json(run({ status: "paused" })));
    const handle = client().run("r1");
    await handle.pause();
    await handle.steer("check the invoice");
    expect(call(0).url).toBe("http://srv/api/runs/r1/pause");
    expect(call(1).url).toBe("http://srv/api/runs/r1/steer");
    expect(JSON.parse(String(call(1).init.body))).toEqual({ message: "check the invoice" });
  });

  it("follows events over SSE", async () => {
    const event = { run_id: "r1", seq: 3, ts: null, type: "agent_started", agent_id: "greet", engine: "code", tokens: null, latency_ms: null, payload: {} };
    mockFetch.mockResolvedValueOnce(new Response(`id: 3\nevent: agent_started\ndata: ${JSON.stringify(event)}\n\n`));
    const seen = [];
    for await (const e of client().run("r1").events({ fromSeq: 3 })) seen.push(e);
    expect(seen).toEqual([event]);
    expect(call().url).toBe("http://srv/api/runs/r1/events?from_seq=3");
    expect((call().init.headers as Record<string, string>).Accept).toBe("text/event-stream");
  });
});

describe("runs and approvals", () => {
  it("lists runs with filters and surfaces refusals", async () => {
    mockFetch.mockResolvedValueOnce(json([run()]));
    expect(await client().runs.list({ workflow: "greet", status: "running", limit: 5 })).toHaveLength(1);
    expect(call().url).toBe("http://srv/api/runs?workflow=greet&status=running&limit=5");
    mockFetch.mockResolvedValueOnce(json({ detail: "Not authenticated" }, 401));
    await expect(client().runs.get("r1")).rejects.toMatchObject({ status: 401, detail: "Not authenticated" });
  });

  it("lists and decides approvals", async () => {
    mockFetch.mockResolvedValueOnce(json([{ approval_id: "a1", kind: "human" }]));
    expect((await client().approvals.list())[0].approval_id).toBe("a1");
    mockFetch.mockResolvedValueOnce(json({ status: "decided" }));
    await client().approvals.decide("a1", { values: { approved: true } });
    expect(call(1).url).toBe("http://srv/api/approvals/a1");
    expect(JSON.parse(String(call(1).init.body))).toEqual({ values: { approved: true } });
  });
});
