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

describe("execute() with files", () => {
  it("sends multipart, leaving the content type to fetch", async () => {
    mockFetch.mockResolvedValueOnce(json({ text: "ok" }, 200, { "x-tuvl-run-id": "r1" }));
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    await new TuvlClient({ baseUrl: "http://srv", token: "tok" }).execute("intake", { doc: file, note: "hi" } as never);
    const { url, init } = call();
    expect(url).toBe("http://srv/api/workflows/intake/runs?wait=true");
    expect(init.body).toBeInstanceOf(FormData);
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers.Authorization).toBe("Bearer tok");
    expect(((init.body as FormData).get("doc") as File).name).toBe("a.txt");
    expect((init.body as FormData).get("note")).toBe("hi");
  });
});

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

describe("live drafts", () => {
  const sse = (...frames: string[]) => new Response(frames.join(""));
  const delta = (agent: string, text: string, replay = false) =>
    `event: token_delta\ndata: ${JSON.stringify({ run_id: "r1", agent_id: agent, delta: text, replay })}\n\n`;
  const reset = (agent: string) => `event: token_reset\ndata: ${JSON.stringify({ run_id: "r1", agent_id: agent })}\n\n`;
  const started = `id: 1\nevent: agent_started\ndata: ${JSON.stringify({ run_id: "r1", seq: 1, type: "agent_started", agent_id: "write" })}\n\n`;

  it("events() never asks for drafts, so it is the journal as before", async () => {
    mockFetch.mockResolvedValueOnce(sse(started));
    for await (const _ of client().run("r1").events()) void _;
    expect(call().url).toBe("http://srv/api/runs/r1/events");
  });

  it("stream() asks for drafts and yields both kinds, in order", async () => {
    mockFetch.mockResolvedValueOnce(sse(started, delta("write", "Hi"), reset("write")));
    const seen = [];
    for await (const e of client().run("r1").stream()) seen.push(e.type);
    expect(call().url).toBe("http://srv/api/runs/r1/events?drafts=true");
    expect(seen).toEqual(["agent_started", "token_delta", "token_reset"]);
  });

  it("tokens() yields only drafts, optionally one agent's", async () => {
    mockFetch.mockResolvedValueOnce(sse(delta("a", "x"), started, delta("b", "y"), delta("a", "z")));
    const seen = [];
    for await (const e of client().run("r1").tokens({ agentId: "a" })) seen.push(e.type === "token_delta" ? e.delta : "reset");
    expect(seen).toEqual(["x", "z"]);
    expect(call().url).toBe("http://srv/api/runs/r1/events?drafts=true");
  });

  it("onToken() hands each piece to the listener and a reset to onReset", async () => {
    mockFetch.mockResolvedValueOnce(sse(delta("write", "He", true), delta("write", "llo"), reset("write"), delta("write", "Hi")));
    let text = "";
    const resets: string[] = [];
    const live = client().run("r1").onToken((piece) => (text += piece), {
      onReset: (agent) => {
        resets.push(agent);
        text = "";
      },
    });
    await live.done;
    expect(text).toBe("Hi");
    expect(resets).toEqual(["write"]);
  });

  it("onToken() stops when asked and does not throw for its own abort", async () => {
    mockFetch.mockImplementationOnce(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(delta("write", "partial")));
          init?.signal?.addEventListener("abort", () => controller.close());
        },
      });
      return new Response(body);
    });
    const pieces: string[] = [];
    const live = client().run("r1").onToken((piece) => pieces.push(piece));
    await new Promise((resolve) => setTimeout(resolve, 20));
    live.stop();
    await expect(live.done).resolves.toBeUndefined();
    expect(pieces).toEqual(["partial"]);
  });

  it("onToken() rejects done when the stream cannot be opened", async () => {
    mockFetch.mockResolvedValueOnce(json({ detail: "Not authenticated" }, 401));
    await expect(client().run("r1").onToken(() => undefined).done).rejects.toMatchObject({ status: 401 });
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

const draft = (agent: string, text: string) =>
  `event: token_delta\ndata: ${JSON.stringify({ run_id: "r1", agent_id: agent, delta: text, replay: false })}\n\n`;

describe("aborting", () => {
  it("wait() stops sleeping when its signal aborts", async () => {
    mockFetch.mockResolvedValue(json(run()));
    const controller = new AbortController();
    const waiting = client().run("r1").wait({ intervalMs: 60_000, signal: controller.signal });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("wait() with a signal that is already aborted does not sleep", async () => {
    mockFetch.mockImplementation(async () => json(run()));
    const controller = new AbortController();
    controller.abort();
    await expect(client().run("r1").wait({ signal: controller.signal, intervalMs: 60_000 })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("onToken() lets go of the caller's signal when the stream ends", async () => {
    mockFetch.mockResolvedValueOnce(new Response(draft("write", "hi")));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pieces: string[] = [];
    await client().run("r1").onToken((piece) => pieces.push(piece), { signal: controller.signal }).done;
    expect(pieces).toEqual(["hi"]);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("onToken() with a signal that is already aborted never reads", async () => {
    mockFetch.mockImplementationOnce(async (_url, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(draft("write", "hi"));
    });
    const controller = new AbortController();
    controller.abort();
    await expect(client().run("r1").onToken(() => undefined, { signal: controller.signal }).done).resolves.toBeUndefined();
  });
});

describe("the rest of the surface", () => {
  it("resume() and abort() post to the run", async () => {
    mockFetch.mockImplementation(async () => json(run()));
    const handle = client().run("r1");
    await handle.resume();
    await handle.abort();
    expect(call(0).url).toBe("http://srv/api/runs/r1/resume");
    expect(call(1).url).toBe("http://srv/api/runs/r1/abort");
    expect(call(1).init.method).toBe("POST");
  });

  it("setToken() changes the token sent from then on", async () => {
    mockFetch.mockImplementation(async () => json([]));
    const c = client();
    await c.runs.list();
    c.setToken("fresh");
    await c.runs.list();
    expect((call(0).init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect((call(1).init.headers as Record<string, string>).Authorization).toBe("Bearer fresh");
  });

  it("runs.export() reads the run's fixture", async () => {
    mockFetch.mockResolvedValueOnce(json({ journal: [] }));
    expect(await client().runs.export("r1")).toEqual({ journal: [] });
    expect(call().url).toBe("http://srv/api/runs/r1/export");
  });

  it("events() rejects with TuvlApiError when the stream is refused", async () => {
    mockFetch.mockResolvedValueOnce(json({ detail: "Access denied" }, 403));
    const read = async () => {
      for await (const _ of client().run("r1").events()) void _;
    };
    await expect(read()).rejects.toMatchObject({ status: 403, detail: "Access denied", path: "/api/runs/r1/events" });
  });
});


describe("edges of the client", () => {
  it("baseUrl is the server's address without a trailing slash", () => {
    expect(client().baseUrl).toBe("http://srv");
  });

  it("execute() maps a refusal that carries no run to TuvlApiError, with the server's reason", async () => {
    mockFetch.mockResolvedValueOnce(json({ detail: "Not authenticated" }, 401));
    await expect(client().execute("greet", { name: "x" })).rejects.toMatchObject({
      name: "TuvlApiError",
      status: 401,
      detail: "Not authenticated",
    });
  });

  it("start() refuses an answer that finished the run instead of starting it", async () => {
    mockFetch.mockResolvedValueOnce(json({ text: "done" }, 200, { "x-tuvl-run-id": "r1" }));
    await expect(client().start("greet", { name: "x" })).rejects.toThrow("finished a run started without waiting");
  });

  it("onToken() ends when the caller's signal aborts while the stream is open", async () => {
    mockFetch.mockImplementationOnce(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.close());
        },
      });
      return new Response(body);
    });
    const parent = new AbortController();
    const live = client().run("r1").onToken(() => undefined, { signal: parent.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    parent.abort();
    await expect(live.done).resolves.toBeUndefined();
  });

  it("reads a run's webhook deliveries and sends one again", async () => {
    mockFetch.mockResolvedValueOnce(json([{ id: "d1", status: "failed" }]));
    expect(await client().runs.webhooks("r 1")).toEqual([{ id: "d1", status: "failed" }]);
    expect(call(0).url).toBe("http://srv/api/runs/r%201/webhooks");
    mockFetch.mockResolvedValueOnce(json({ id: "d1", status: "queued" }));
    await client().runs.redeliverWebhook("r1", "d/1");
    expect(call(1).url).toBe("http://srv/api/runs/r1/webhooks/d%2F1/redeliver");
    expect(call(1).init.method).toBe("POST");
  });
});
