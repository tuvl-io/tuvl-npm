/**
 * Against a running tuvl server (skipped unless TUVL_LIVE_URL is set).
 * The server must serve the `approve_amount` workflow (decide → human) — see
 * `live/workflows/approve_amount.yaml` in any tuvl 2.0 project — and TUVL_LIVE_TOKEN must
 * carry `runs:read` + `approvals:decide` (an admin or the dev key works).
 */
import { describe, expect, it } from "vitest";
import { TuvlAuth } from "./auth";
import { RunHandle, TuvlClient } from "./client";
import { readToken } from "./token";
import { generate, type OpenApiDocument } from "./generate";
import type { RunEvent } from "./types";

const url = process.env.TUVL_LIVE_URL;
const token = process.env.TUVL_LIVE_TOKEN;

type Workflows = {
  approve_amount: { input: { amount: number; note?: string | null }; output: { amount: number; lane: "auto" | "review" } };
};

describe.skipIf(!url)("live server", () => {
  const client = new TuvlClient<Workflows>({ baseUrl: url ?? "", token });

  it.skipIf(token?.split(".").length !== 3)("reads the token's claims as the server sees them", async () => {
    const me = await new TuvlAuth({ baseUrl: url ?? "" }).getMe(token ?? "");
    const claims = readToken(token ?? "");
    expect(claims.iss).toBe("tuvl");
    expect({ user_id: claims.sub, groups: claims.groups, scopes: claims.scopes }).toEqual({
      user_id: me.user_id,
      groups: me.groups,
      scopes: me.scopes,
    });
  });

  it("generates types from /openapi.json", async () => {
    const doc = (await (await fetch(`${url}/openapi.json`)).json()) as OpenApiDocument;
    const code = generate(doc);
    expect(code).toContain("approve_amount: {");
    expect(code).toMatch(/amount: number;/);
    expect(code).toContain('lane: "auto" | "review";');
  });

  it("executes synchronously", async () => {
    expect(await client.execute("approve_amount", { amount: 20 })).toEqual({ amount: 20, lane: "auto" });
  });

  it("follows a run that waits on a person, decides it and waits for the output", async () => {
    const handle = await client.execute("approve_amount", { amount: 500 });
    expect(handle).toBeInstanceOf(RunHandle);
    const run = handle as RunHandle<Workflows["approve_amount"]["output"]>;
    expect(run.run?.status).toBe("waiting_human");
    const approval = (await client.approvals.list()).find((a) => a.run_id === run.id);
    expect(approval?.kind).toBe("human");
    await client.approvals.decide(approval?.approval_id ?? "", { values: { approved: true } });
    expect(await run.wait({ intervalMs: 200, timeoutMs: 15_000 })).toEqual({ amount: 500, lane: "review" });
    const types: string[] = [];
    for await (const event of run.events({ follow: false })) types.push((event as RunEvent).type);
    expect(types).toEqual(expect.arrayContaining(["run_started", "decision", "approval_requested", "approval_decided", "run_completed"]));
  });

  it("rejects bad input with TuvlApiError", async () => {
    await expect(client.execute("approve_amount", { amount: "x" as unknown as number })).rejects.toMatchObject({ status: 422 });
  });
});
