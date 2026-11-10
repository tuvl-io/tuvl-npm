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

/**
 * Role membership against a server that mounts the `roles` group (tuvl >= 2.1.0b2, `roles` in `spec.api.expose`).
 * TUVL_LIVE_MANAGER_TOKEN needs `roles:manage`; TUVL_LIVE_ROLE names a role the manager may change
 * (default `reviewers`) and TUVL_LIVE_USER a user who does not hold it yet (default `bob@example.com`).
 * The test restores what it changes.
 */
const managerToken = process.env.TUVL_LIVE_MANAGER_TOKEN;

describe.skipIf(!url || !managerToken)("live server: role management", () => {
  const roleName = process.env.TUVL_LIVE_ROLE ?? "reviewers";
  const email = process.env.TUVL_LIVE_USER ?? "bob@example.com";
  const roles = new TuvlClient({ baseUrl: url ?? "", token: managerToken }).roles();

  it("lists roles, adds and removes a member, and disables and re-enables the role", async () => {
    expect(await roles.isAvailable()).toBe(true);
    const role = (await roles.list()).find((r) => r.name === roleName);
    expect(role).toBeDefined();
    const roleId = role?.id ?? "";

    const user = (await roles.findUsers({ q: email })).items.find((u) => u.email === email);
    expect(user).toBeDefined();
    const userId = user?.id ?? "";

    await roles.addUser(roleId, userId);
    await roles.addUser(roleId, userId); // idempotent
    try {
      expect((await roles.members(roleId)).items.map((m) => m.email)).toContain(email);
      expect((await roles.disable(roleId)).is_active).toBe(false);
      expect((await roles.enable(roleId)).is_active).toBe(true);
    } finally {
      await roles.removeUser(roleId, userId);
    }
    expect((await roles.members(roleId)).items.map((m) => m.email)).not.toContain(email);
    await expect(roles.removeUser(roleId, userId)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a role that carries more than the manager holds", async () => {
    const all = await roles.list();
    const protectedRole = all.find((r) => r.scopes.includes("iam:admin"));
    const someone = (await roles.findUsers({ limit: 1 })).items[0];
    if (!protectedRole || !someone) return;
    await expect(roles.addUser(protectedRole.id, someone.id)).rejects.toMatchObject({ status: 403 });
  });
});
