/**
 * A followed stream that ends is not a run that ended: the client reopens it from the last position it read, and says
 * so (TuvlStreamError) when it cannot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TuvlClient } from "./client";
import { isTokenEvent, TuvlApiError, TuvlStreamError, type Run, type RunStreamEvent } from "./types";

const mockFetch = vi.fn<typeof fetch>();
const encoder = new TextEncoder();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const client = () => new TuvlClient({ baseUrl: "http://srv", token: "tok" });

const journal = (seq: number, type = "agent_started") =>
  `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ run_id: "r1", seq, ts: null, type, agent_id: "a", engine: null, tokens: null, latency_ms: null, payload: {} })}\n\n`;
const delta = (text: string, replay = false) =>
  `event: token_delta\ndata: ${JSON.stringify({ run_id: "r1", agent_id: "a", delta: text, replay })}\n\n`;

/** A stream that delivers `frames`, then ends cleanly or breaks the way a dropped connection does. */
function sse(frames: string[], end: "close" | "drop" = "close", afterMs = 0): Response {
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i < frames.length) return controller.enqueue(encoder.encode(frames[i++]));
        if (afterMs) await new Promise((resolve) => setTimeout(resolve, afterMs));
        if (end === "close") controller.close();
        else controller.error(new TypeError("terminated"));
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

const run = (status: Run["status"]): Run => ({
  run_id: "r1",
  workflow: "w",
  status,
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
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Answer each request from its queue: `events` for the stream, `runs` for `GET /api/runs/r1`. */
function server(events: Array<() => Response | Promise<Response>>, runs: Array<() => Response | Promise<Response>> = []) {
  mockFetch.mockImplementation(async (input) => {
    const next = String(input).includes("/events") ? events.shift() : runs.shift();
    if (!next) throw new Error(`unexpected request to ${String(input)}`);
    return next();
  });
}

const urls = () => mockFetch.mock.calls.map(([url]) => String(url));

/** Let the clock run until `promise` settles. */
async function settle(promise: Promise<unknown>): Promise<void> {
  let finished = false;
  promise.then(
    () => (finished = true),
    () => (finished = true),
  );
  while (!finished) await vi.advanceTimersByTimeAsync(1_000);
}

/** Read the generator to its end while the clock runs. */
async function drain<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  const reading = (async () => {
    for await (const item of generator) out.push(item);
  })();
  reading.catch(() => undefined);
  await settle(reading);
  await reading;
  return out;
}

const seqs = (events: RunStreamEvent[]) => events.filter((e) => !isTokenEvent(e)).map((e) => (e as { seq: number }).seq);

describe("following a run", () => {
  it("stops at the run's last event without asking anything else", async () => {
    server([() => sse([journal(1), journal(2, "run_completed")])]);
    expect(seqs(await drain(client().run("r1").events()))).toEqual([1, 2]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["run_failed", "run_aborted"])("%s is a last event too", async (type) => {
    server([() => sse([journal(1), journal(2, type)])]);
    expect(seqs(await drain(client().run("r1").events()))).toEqual([1, 2]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("reopens the stream from the next position when the connection drops", async () => {
    server(
      [() => sse([journal(1), journal(2)], "drop"), () => sse([journal(3), journal(4, "run_completed")])],
      [() => json(run("running"))],
    );
    expect(seqs(await drain(client().run("r1").events()))).toEqual([1, 2, 3, 4]);
    expect(urls()).toEqual(["http://srv/api/runs/r1/events", "http://srv/api/runs/r1", "http://srv/api/runs/r1/events?from_seq=3"]);
  });

  it("does not take a stream the server closed for the end of a run that is still going", async () => {
    server(
      [() => sse([journal(1)]), () => sse([journal(2), journal(3, "run_completed")])],
      [() => json(run("waiting_human"))],
    );
    expect(seqs(await drain(client().run("r1").events()))).toEqual([1, 2, 3]);
    expect(urls()[2]).toBe("http://srv/api/runs/r1/events?from_seq=2");
  });

  it("resumes after the last position read when positions have gaps", async () => {
    server(
      [() => sse([journal(1), journal(2), journal(5)], "drop"), () => sse([journal(7), journal(8, "run_completed")])],
      [() => json(run("running"))],
    );
    expect(seqs(await drain(client().run("r1").events()))).toEqual([1, 2, 5, 7, 8]);
    expect(urls()[2]).toBe("http://srv/api/runs/r1/events?from_seq=6");
  });

  it("does not hand over an event twice if the server sends it again", async () => {
    server(
      [() => sse([journal(1), journal(2)], "drop"), () => sse([journal(2), journal(3, "run_completed")])],
      [() => json(run("running"))],
    );
    expect(seqs(await drain(client().run("r1").events()))).toEqual([1, 2, 3]);
  });

  it("reads what a run did while the client was away, then stops", async () => {
    server(
      [() => sse([journal(1)], "drop"), () => sse([journal(2), journal(3, "run_completed")])],
      [() => json(run("completed"))],
    );
    expect(seqs(await drain(client().run("r1").events()))).toEqual([1, 2, 3]);
    expect(urls()[2]).toBe("http://srv/api/runs/r1/events?from_seq=2&follow=false");
  });

  it("starts from fromSeq and resumes past it", async () => {
    server([() => sse([journal(5)], "drop"), () => sse([journal(6, "run_completed")])], [() => json(run("running"))]);
    await drain(client().run("r1").events({ fromSeq: 5 }));
    expect(urls()[0]).toBe("http://srv/api/runs/r1/events?from_seq=5");
    expect(urls()[2]).toBe("http://srv/api/runs/r1/events?from_seq=6");
  });

  it("keeps the caller's token on the status check and the reconnect", async () => {
    server([() => sse([journal(1)], "drop"), () => sse([journal(2, "run_completed")])], [() => json(run("running"))]);
    await drain(client().run("r1").events({ token: "other" }));
    const sent = mockFetch.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>).Authorization);
    expect(sent).toEqual(["Bearer other", "Bearer other", "Bearer other"]);
  });
});

describe("when the stream cannot be reopened", () => {
  it("throws a TuvlStreamError that says where it stopped and why", async () => {
    mockFetch.mockImplementationOnce(async () => sse([journal(1), journal(2)], "drop"));
    mockFetch.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    const failure = await drain(client().run("r1").events()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TuvlStreamError);
    expect(failure).toMatchObject({ runId: "r1", lastSeq: 2, name: "TuvlStreamError" });
    expect((failure as TuvlStreamError).cause).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain("after seq 2");
  });

  it("gives up after five attempts in a row, pausing longer each time", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const stamps: number[] = [];
    mockFetch.mockImplementationOnce(async () => sse([journal(1)], "drop"));
    mockFetch.mockImplementation(async () => {
      stamps.push(Date.now());
      throw new TypeError("fetch failed");
    });
    await expect(drain(client().run("r1").events())).rejects.toBeInstanceOf(TuvlStreamError);
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    expect(gaps).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
  });

  it("does not retry a refusal: a revoked token or a missing run is not a dropped connection", async () => {
    server(
      [() => sse([journal(1)], "drop"), () => json({ detail: "Not authenticated" }, 401)],
      [() => json(run("running"))],
    );
    await expect(drain(client().run("r1").events())).rejects.toMatchObject({ status: 401 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries a 503 and honours its Retry-After", async () => {
    const stamps: number[] = [];
    mockFetch.mockImplementation(async (input) => {
      stamps.push(Date.now());
      const url = String(input);
      if (stamps.length === 1) return sse([journal(1)], "drop");
      if (!url.includes("/events")) return json(run("running"));
      if (stamps.length === 3) return new Response('{"detail":"busy"}', { status: 503, headers: { "Retry-After": "7" } });
      return sse([journal(2, "run_completed")]);
    });
    expect(seqs(await drain(client().run("r1").events()))).toEqual([1, 2]);
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(7_000);
  });

  it("does not retry the first connection: a wrong address says so at once", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(drain(client().run("r1").events())).rejects.toThrow("fetch failed");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not count a connection that stayed open against the attempts", async () => {
    // a proxy that closes an idle stream every 6 seconds: more closes than attempts, and no error
    const events = Array.from({ length: 8 }, () => () => sse([], "close", 6_000));
    events.push(() => sse([journal(1, "run_completed")]));
    server(events, Array.from({ length: 8 }, () => () => json(run("waiting_human"))));
    expect(seqs(await drain(client().run("r1").events()))).toEqual([1]);
  });
});

describe("modes that do not reconnect", () => {
  it("follow: false is one pass: no status check, no reconnect", async () => {
    server([() => sse([journal(1), journal(2)])]);
    expect(seqs(await drain(client().run("r1").events({ follow: false })))).toEqual([1, 2]);
    expect(urls()).toEqual(["http://srv/api/runs/r1/events?follow=false"]);
  });

  it("follow: false lets a dropped connection through, as before", async () => {
    server([() => sse([journal(1)], "drop")]);
    await expect(drain(client().run("r1").events({ follow: false }))).rejects.toThrow("terminated");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("an abort ends the stream without reconnecting", async () => {
    const controller = new AbortController();
    server([() => sse([journal(1)], "drop")], [() => json(run("running"))]);
    const seen: number[] = [];
    const reading = (async () => {
      for await (const event of client().run("r1").events({ signal: controller.signal })) {
        seen.push(event.seq);
        controller.abort();
      }
    })();
    await vi.advanceTimersByTimeAsync(10_000);
    await reading;
    expect(seen).toEqual([1]);
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("drafts across a reconnect", () => {
  it("resets what the caller shows, then takes the replayed draft", async () => {
    server(
      [() => sse([delta("Hel")], "drop"), () => sse([delta("Hello wor", true), delta("ld"), journal(9, "run_completed")])],
      [() => json(run("running"))],
    );
    let text = "";
    const live = client().run("r1").onToken((piece) => (text += piece), { onReset: () => (text = "") });
    await settle(live.done);
    expect(text).toBe("Hello world");
    expect(urls()[2]).toBe("http://srv/api/runs/r1/events?drafts=true");
  });

  it("stream() shows the reset between the two connections", async () => {
    server(
      [() => sse([journal(1), delta("a")], "drop"), () => sse([delta("a", true), journal(2, "run_completed")])],
      [() => json(run("running"))],
    );
    const kinds = (await drain(client().run("r1").stream())).map((e) => (isTokenEvent(e) ? `${e.type}${e.type === "token_delta" && e.replay ? ":replay" : ""}` : e.type));
    expect(kinds).toEqual(["agent_started", "token_delta", "token_reset", "token_delta:replay", "run_completed"]);
  });

  it("a draft the caller has finished showing is not reset again", async () => {
    server(
      [
        () => sse([delta("a"), `event: token_reset\ndata: ${JSON.stringify({ run_id: "r1", agent_id: "a" })}\n\n`], "drop"),
        () => sse([journal(1, "run_completed")]),
      ],
      [() => json(run("running"))],
    );
    const kinds = (await drain(client().run("r1").stream())).map((e) => e.type);
    expect(kinds).toEqual(["token_delta", "token_reset", "run_completed"]);
  });
});

describe("onToken and an unobserved failure", () => {
  it("a stream that fails does not become an unhandled rejection when nobody awaits done", async () => {
    vi.useRealTimers();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      mockFetch.mockResolvedValueOnce(json({ detail: "Not authenticated" }, 401));
      const live = client().run("r1").onToken(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
      await expect(live.done).rejects.toBeInstanceOf(TuvlApiError);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
