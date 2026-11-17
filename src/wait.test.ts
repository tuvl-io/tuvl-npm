/**
 * wait(): polls with a growing pause, rides out a server that is briefly unwell, and stops when it is told to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TuvlClient } from "./client";
import { TuvlApiError, TuvlTimeoutError, type Run } from "./types";

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const handle = () => new TuvlClient({ baseUrl: "http://srv", token: "tok" }).run<{ ok: boolean }>("r1");

const run = (status: Run["status"], overrides: Partial<Run> = {}): Run => ({
  run_id: "r1",
  workflow: "w",
  status,
  trigger: "api",
  current_agent: null,
  end: null,
  output: status === "completed" ? { status: 200, body: { ok: true } } : null,
  error: null,
  tokens_used: 0,
  created_at: null,
  updated_at: null,
  status_url: "/api/runs/r1",
  events_url: "/api/runs/r1/events",
  ...overrides,
});

type Step = Run | "network" | number | { status: number; headers: Record<string, string> };

/** The answers to successive polls, and when each was asked. */
function polls(steps: Step[]): number[] {
  const stamps: number[] = [];
  let i = 0;
  mockFetch.mockImplementation(async () => {
    stamps.push(Date.now());
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step === "network") throw new TypeError("fetch failed");
    if (typeof step === "number") return new Response(JSON.stringify({ detail: "no" }), { status: step });
    if ("headers" in step) return new Response(JSON.stringify({ detail: "slow down" }), { status: step.status, headers: step.headers });
    return new Response(JSON.stringify(step), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return stamps;
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  let finished = false;
  const settled = promise.then(
    (value): PromiseSettledResult<T> => {
      finished = true;
      return { status: "fulfilled", value };
    },
    (reason): PromiseSettledResult<T> => {
      finished = true;
      return { status: "rejected", reason };
    },
  );
  while (!finished) await vi.advanceTimersByTimeAsync(500);
  return settled;
}

const gaps = (stamps: number[]) => stamps.slice(1).map((t, i) => t - stamps[i]);
const running = (n: number, overrides: Partial<Run> = {}): Step[] => Array.from({ length: n }, () => run("running", overrides));

describe("wait() backs off", () => {
  it("slows by half again each poll while nothing changes, up to the cap", async () => {
    const stamps = polls([...running(8), run("completed")]);
    const result = await settle(handle().wait({ intervalMs: 100, maxIntervalMs: 400 }));
    expect(result).toMatchObject({ status: "fulfilled", value: { ok: true } });
    expect(gaps(stamps)).toEqual([100, 150, 225, 338, 400, 400, 400, 400]);
  });

  it("starts at 500 ms and stops growing at 5 s", async () => {
    const stamps = polls([...running(12), run("completed")]);
    await settle(handle().wait());
    const pauses = gaps(stamps);
    expect(pauses.slice(0, 4)).toEqual([500, 750, 1125, 1688]);
    expect(Math.max(...pauses)).toBe(5_000);
  });

  it("keeps a fixed interval when the cap is the interval", async () => {
    const stamps = polls([...running(4), run("completed")]);
    await settle(handle().wait({ intervalMs: 200, maxIntervalMs: 200 }));
    expect(gaps(stamps)).toEqual([200, 200, 200, 200]);
  });

  it("starts again from the first interval when the run moves on", async () => {
    const stamps = polls([...running(3, { current_agent: "a" }), ...running(2, { current_agent: "b" }), run("completed")]);
    await settle(handle().wait({ intervalMs: 100, maxIntervalMs: 1_000 }));
    expect(gaps(stamps)).toEqual([100, 150, 225, 100, 150]);
  });

  it("does not stop at a run that waits on a person unless asked to", async () => {
    polls([...running(2, { status: "waiting_human" }), run("completed")]);
    expect(await settle(handle().wait({ intervalMs: 10 }))).toMatchObject({ status: "fulfilled", value: { ok: true } });
    polls([run("waiting_human")]);
    expect(await settle(handle().wait({ intervalMs: 10, untilWaiting: true }))).toMatchObject({ status: "fulfilled", value: undefined });
  });
});

describe("wait() and a server that is briefly unwell", () => {
  it("rides out five failures in a row", async () => {
    polls([503, "network", 502, 504, "network", run("completed")]);
    expect(await settle(handle().wait({ intervalMs: 100 }))).toMatchObject({ status: "fulfilled", value: { ok: true } });
  });

  it("gives up at the sixth and rejects with what the server said", async () => {
    polls([503, 503, 503, 503, 503, 503, run("completed")]);
    const result = await settle(handle().wait({ intervalMs: 100 }));
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(TuvlApiError);
    expect((result as PromiseRejectedResult).reason).toMatchObject({ status: 503 });
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it("counts failures in a row: a good answer starts the count again", async () => {
    polls([503, 503, 503, 503, run("running"), 503, 503, 503, 503, run("completed")]);
    expect(await settle(handle().wait({ intervalMs: 100 }))).toMatchObject({ status: "fulfilled", value: { ok: true } });
  });

  it.each([401, 403, 404, 422])("rejects at once on a %i: it is not going to get better", async (code) => {
    polls([code, run("completed")]);
    expect(await settle(handle().wait({ intervalMs: 100 }))).toMatchObject({ status: "rejected", reason: { status: code } });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("waits at least as long as a 429 asks", async () => {
    const stamps = polls([{ status: 429, headers: { "Retry-After": "9" } }, run("completed")]);
    await settle(handle().wait({ intervalMs: 100 }));
    expect(gaps(stamps)).toEqual([9_000]);
  });

  it("reads a Retry-After that is a date", async () => {
    const at = new Date(Date.now() + 12_000).toUTCString();
    const stamps = polls([{ status: 503, headers: { "Retry-After": at } }, run("completed")]);
    await settle(handle().wait({ intervalMs: 100 }));
    expect(gaps(stamps)[0]).toBeGreaterThanOrEqual(11_000);
  });

  it("does not wait for a Retry-After of an hour", async () => {
    const stamps = polls([{ status: 503, headers: { "Retry-After": "3600" } }, run("completed")]);
    await settle(handle().wait({ intervalMs: 100 }));
    expect(gaps(stamps)[0]).toBe(60_000);
  });
});

describe("wait() and its timeout", () => {
  it("rejects with a TuvlTimeoutError that names the run, its status and the time", async () => {
    polls(running(50));
    const result = await settle(handle().wait({ intervalMs: 100, timeoutMs: 1_000 }));
    expect(result.status).toBe("rejected");
    const error = (result as PromiseRejectedResult).reason as TuvlTimeoutError;
    expect(error).toBeInstanceOf(TuvlTimeoutError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ runId: "r1", status: "running", timeoutMs: 1_000, name: "TuvlTimeoutError" });
    expect(error.message).toBe("tuvl run r1 is still running after 1000ms");
  });

  it("looks one last time at the deadline rather than before it", async () => {
    const stamps = polls(running(50));
    await settle(handle().wait({ intervalMs: 100, timeoutMs: 1_000 }));
    expect(stamps[stamps.length - 1] - stamps[0]).toBe(1_000);
  });

  it("returns the output if the run ends on that last look", async () => {
    polls([...running(4), run("completed")]);
    const result = await settle(handle().wait({ intervalMs: 100, maxIntervalMs: 100, timeoutMs: 400 }));
    expect(result).toMatchObject({ status: "fulfilled", value: { ok: true } });
  });

  it("says the status is unknown when it could not be read", async () => {
    polls([503]);
    const result = await settle(handle().wait({ intervalMs: 100, timeoutMs: 500 }));
    expect((result as PromiseRejectedResult).reason).toMatchObject({ name: "TuvlTimeoutError", status: undefined });
    expect((result as PromiseRejectedResult).reason.message).toBe("tuvl run r1 is still unknown after 500ms");
  });
});
