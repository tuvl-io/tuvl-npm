import { describe, expect, it } from "vitest";
import { TERMINAL_STATUSES, TuvlApiError, TuvlRunError, WAITING_STATUSES } from "./types";

describe("errors", () => {
  it("carry what the server said", () => {
    const api = new TuvlApiError(403, "Access denied. Required scope: 'greet:run'.", "/api/workflows/greet/runs");
    expect(api).toBeInstanceOf(Error);
    expect(api.name).toBe("TuvlApiError");
    expect(api.message).toContain("HTTP 403");
    const run = new TuvlRunError(422, { error: "bad" }, "r1");
    expect(run.message).toContain('{"error":"bad"}');
    expect(run.runId).toBe("r1");
  });

  it("a run error without a run id says so", () => {
    expect(new TuvlRunError(500, null, null).message).toContain("run ?");
  });

  it("statuses are disjoint", () => {
    expect(TERMINAL_STATUSES.filter((s) => WAITING_STATUSES.includes(s))).toEqual([]);
  });
});
