/**
 * What the client says about the engine matches what the engine does (tuvl 2.1): the run states, the journal's event
 * types, the shape of a run answered to an anonymous caller, an approval, and `Retry-After`.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { TuvlClient } from "./client";
import { retryAfter } from "./transport";
import { TERMINAL_STATUSES, type TuvlApiError, WAITING_STATUSES, type Approval, type Run, type RunEventType, type RunStatus } from "./types";

// What `tuvl.runtime.models.RunStatus` and `tuvl.runtime.journal.EVENT_TYPES` list in 2.1.
const ENGINE_STATUSES = [
  "queued",
  "running",
  "waiting_human",
  "waiting_approval",
  "paused",
  "completed",
  "failed",
  "aborted",
  "compensating",
  "compensated",
] as const;
const ENGINE_EVENTS = [
  "run_queued",
  "run_started",
  "agent_started",
  "agent_completed",
  "signal",
  "llm_turn",
  "tool_call",
  "tool_result",
  "memory_recalled",
  "memory_written",
  "memory_compacted",
  "map_started",
  "map_item",
  "map_finished",
  "parallel_started",
  "parallel_branch",
  "parallel_finished",
  "decision",
  "judge_verdict",
  "supervisor",
  "approval_requested",
  "approval_decided",
  "paused",
  "resumed",
  "checkpoint",
  "compensation_started",
  "compensation_completed",
  "run_completed",
  "run_failed",
  "run_aborted",
] as const;

describe("the types follow the engine", () => {
  it("RunStatus is the engine's set, compensating included", () => {
    expectTypeOf<RunStatus>().toEqualTypeOf<(typeof ENGINE_STATUSES)[number]>();
  });

  it("RunEventType is the journal's set", () => {
    expectTypeOf<RunEventType>().toEqualTypeOf<(typeof ENGINE_EVENTS)[number]>();
  });

  it("compensating is neither final nor a wait for someone, so wait() keeps polling through it", () => {
    expect(TERMINAL_STATUSES).not.toContain("compensating");
    expect(WAITING_STATUSES).not.toContain("compensating");
  });

  it("an anonymous run has no urls, and an approval can name its assignee", () => {
    expectTypeOf<Run["status_url"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Run["events_url"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Approval["assignee"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<TuvlApiError["retryAfter"]>().toEqualTypeOf<number | undefined>();
  });
});

describe("Retry-After", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-17T12:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  const headers = (value?: string) => new Headers(value === undefined ? {} : { "Retry-After": value });

  it("is the seconds the server said", () => {
    expect(retryAfter(headers("2"))).toBe(2);
    expect(retryAfter(headers(" 120 "))).toBe(120);
    expect(retryAfter(headers("0"))).toBe(0);
  });

  it("can be a date", () => {
    expect(retryAfter(headers("Tue, 17 Nov 2026 12:00:30 GMT"))).toBe(30);
    expect(retryAfter(headers("Tue, 17 Nov 2026 11:59:00 GMT"))).toBe(0); // already past
  });

  it("is undefined when absent or unreadable", () => {
    expect(retryAfter(headers())).toBeUndefined();
    expect(retryAfter(headers(""))).toBeUndefined();
    expect(retryAfter(headers("soon"))).toBeUndefined();
    expect(retryAfter(headers("-5"))).toBeUndefined();
  });
});

describe("a failed sign-in that is throttled", () => {
  const mockFetch = vi.fn<typeof fetch>();
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("carries the wait on the error", async () => {
    mockFetch.mockResolvedValueOnce(new Response('{"detail":"Too many failed attempts"}', { status: 429, headers: { "Retry-After": "2", "Content-Type": "application/json" } }));
    const { TuvlAuth } = await import("./auth");
    await expect(new TuvlAuth({ baseUrl: "http://srv" }).loginWithPassword("a@b.c", "x")).rejects.toMatchObject({ status: 429, retryAfter: 2 });
  });
});

describe("a handle on a run nobody can read", () => {
  const mockFetch = vi.fn<typeof fetch>();
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  const anonymous = (): Run => ({
    run_id: "r1",
    workflow: "w",
    status: "waiting_human",
    trigger: "api",
    current_agent: "approval",
    end: null,
    output: null,
    error: null,
    tokens_used: 0,
    created_at: null,
    updated_at: null,
  });
  const refused = () => new Response('{"detail":"Not authenticated"}', { status: 401, headers: { "Content-Type": "application/json" } });

  async function handle() {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(anonymous()), { status: 202, headers: { "x-tuvl-run-id": "r1", "Content-Type": "application/json" } }));
    return new TuvlClient({ baseUrl: "http://srv" }).start("w", {});
  }

  it("is told why: get() and wait()", async () => {
    const run = await handle();
    mockFetch.mockImplementation(async () => refused());
    await expect(run.get()).rejects.toMatchObject({ status: 401, message: expect.stringContaining("anonymous caller of a public trigger") });
    await expect(run.wait({ timeoutMs: 1_000 })).rejects.toMatchObject({ status: 401, message: expect.stringContaining("iam:admin") });
  });

  it("is told why: events() and onToken()", async () => {
    const run = await handle();
    mockFetch.mockImplementation(async () => refused());
    await expect(run.events().next()).rejects.toMatchObject({ status: 401, message: expect.stringContaining("anonymous") });
    await expect(run.onToken(() => undefined).done).rejects.toMatchObject({ message: expect.stringContaining("anonymous") });
  });

  it("keeps what the server said, so nothing is lost", async () => {
    const run = await handle();
    mockFetch.mockImplementation(async () => refused());
    await expect(run.get()).rejects.toMatchObject({ detail: expect.stringContaining("Not authenticated"), path: "/api/runs/r1" });
  });

  it("a run that has urls, or a handle that never saw the run, gets the server's words unchanged", async () => {
    mockFetch.mockImplementation(async () => refused());
    const bare = new TuvlClient({ baseUrl: "http://srv", token: "t" }).run("r1");
    await expect(bare.get()).rejects.toMatchObject({ status: 401, detail: "Not authenticated" });
    const owned = new TuvlClient({ baseUrl: "http://srv", token: "t" }).run("r1");
    owned.run = { ...anonymous(), status_url: "/api/runs/r1", events_url: "/api/runs/r1/events" };
    await expect(owned.get()).rejects.toMatchObject({ detail: "Not authenticated" });
  });

  it("does not hide a failure that is not a refusal", async () => {
    const run = await handle();
    mockFetch.mockImplementation(async () => new Response("{}", { status: 500 }));
    await expect(run.get()).rejects.toMatchObject({ status: 500, detail: {} });
  });
});
