/**
 * Tests for TuvlWorkflowError, TuvlWorkflowSuspendedError and agentProgress.
 */
import { describe, it, expect } from "vitest";
import { TuvlWorkflowError, TuvlWorkflowSuspendedError, agentProgress } from "./types";

describe("TuvlWorkflowError", () => {
  it("is an instance of Error", () => {
    const err = new TuvlWorkflowError("failed", null, null);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TuvlWorkflowError);
  });

  it("sets message, data and error payload", () => {
    const payload = { code: "NOT_FOUND", message: "not found" };
    const err = new TuvlWorkflowError("wf failed", { partial: true }, payload);
    expect(err.message).toBe("wf failed");
    expect(err.data).toEqual({ partial: true });
    expect(err.error).toEqual(payload);
  });

  it("has the correct name", () => {
    const err = new TuvlWorkflowError("msg", null, null);
    expect(err.name).toBe("TuvlWorkflowError");
  });
});

describe("TuvlWorkflowSuspendedError", () => {
  it("is an instance of Error", () => {
    const event = {
      event_type: "suspended" as const,
      instance_id: "i1",
      paused_step_id: "review",
    };
    const err = new TuvlWorkflowSuspendedError(event);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TuvlWorkflowSuspendedError);
  });

  it("stores the full suspended event", () => {
    const event = {
      event_type: "suspended" as const,
      instance_id: "i1",
      paused_step_id: "review",
      ui: { title: "Approve?" },
    };
    const err = new TuvlWorkflowSuspendedError(event);
    expect(err.suspended).toEqual(event);
    expect(err.message).toContain("suspended");
  });

  it("has the correct name", () => {
    const err = new TuvlWorkflowSuspendedError({ event_type: "suspended" });
    expect(err.name).toBe("TuvlWorkflowSuspendedError");
  });
});

describe("agentProgress", () => {
  it("reads an iteration progress frame", () => {
    const ev = {
      kind: "Agent",
      signal: "running",
      snapshot: { agent_progress: { type: "iteration", iteration: 2, tool_calls: 1, tokens_used: 40 } },
    };
    const p = agentProgress(ev);
    expect(p).toEqual({ type: "iteration", iteration: 2, tool_calls: 1, tokens_used: 40 });
  });

  it("reads a tool_call progress frame", () => {
    const p = agentProgress({
      kind: "Agent",
      signal: "running",
      snapshot: { agent_progress: { type: "tool_call", iteration: 1, tool: "lookup_order", signal: "default" } },
    });
    expect(p?.type).toBe("tool_call");
    expect(p?.tool).toBe("lookup_order");
  });

  it("returns null for the terminating outcome frame (not signal=running)", () => {
    const ev = {
      kind: "Agent",
      signal: "resolved",
      snapshot: { agent_result: "done" },
    };
    expect(agentProgress(ev)).toBeNull();
  });

  it("returns null for non-agent steps", () => {
    expect(agentProgress({ kind: "Functional", signal: "running", snapshot: {} })).toBeNull();
  });

  it("returns null when no agent_progress payload is present", () => {
    expect(agentProgress({ kind: "Agent", signal: "running", snapshot: {} })).toBeNull();
  });
});
