/**
 * Tests for TuvlWorkflowError and TuvlWorkflowSuspendedError.
 */
import { describe, it, expect } from "vitest";
import { TuvlWorkflowError, TuvlWorkflowSuspendedError } from "./types";

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
