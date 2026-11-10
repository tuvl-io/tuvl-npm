import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebhookError, verifyWebhook, webhookHandler } from "./webhooks";

const SECRET = "k".repeat(40);
const OLD = "o".repeat(40);
const T = 1_700_000_000;

// The same vector the engine tests (tests/webhooks/test_guard_and_signing.py) check.
const BODY =
  '{"agent":"greet","created_at":"2026-10-20T14:00:00+00:00","id":"3f2b8c1e-0000-4000-8000-000000000001",' +
  '"run_id":"3f2b8c1e-0000-4000-8000-000000000002","seq":7,"type":"agent.completed","workflow":"greet"}';
const VECTOR = "2bf17cddc7bfd9f1ec522950790b89ab293ed9680b8580b041643e09fd8a9543";

const mac = (secret: string, t: number, body: string) =>
  createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
const header = (t = T, ...secrets: string[]) =>
  [`t=${t}`, ...(secrets.length ? secrets : [SECRET]).map((s) => `v1=${mac(s, t, BODY)}`)].join(",");
const verify = (h: string | null | undefined, secrets: string | string[] = SECRET, body = BODY, now = T) =>
  verifyWebhook(body, h, secrets, { now });

describe("verifyWebhook", () => {
  it("agrees with the engine's signature on the published vector", () => {
    expect(mac(SECRET, T, BODY)).toBe(VECTOR);
  });

  it("returns the notification when the signature is genuine", async () => {
    const n = await verify(header());
    expect(n).toMatchObject({ type: "agent.completed", run_id: "3f2b8c1e-0000-4000-8000-000000000002", seq: 7, agent: "greet" });
  });

  it("accepts bytes as well as text", async () => {
    const n = await verifyWebhook(new TextEncoder().encode(BODY), header(), SECRET, { now: T });
    expect(n.workflow).toBe("greet");
  });

  it("rejects an altered body, the wrong secret and a missing or garbled header", async () => {
    await expect(verify(header(), SECRET, BODY.replace('"seq":7', '"seq":8'))).rejects.toMatchObject({ reason: "signature" });
    await expect(verify(header(), "x".repeat(40))).rejects.toMatchObject({ reason: "signature" });
    for (const bad of [null, undefined, "", "v1=abc", `t=${T}`, `t=${T},v1=zz`, `t=1,t=2,v1=${VECTOR}`, "nonsense"]) {
      await expect(verify(bad)).rejects.toBeInstanceOf(WebhookError);
    }
  });

  it("rejects a replay outside the tolerance and accepts one inside it", async () => {
    await expect(verify(header(T - 301))).rejects.toMatchObject({ reason: "stale" });
    await expect(verify(header(T + 301))).rejects.toMatchObject({ reason: "stale" });
    await expect(verify(header(T - 299))).resolves.toBeTruthy();
    await expect(verifyWebhook(BODY, header(T - 1000), SECRET, { now: T, toleranceSeconds: 2000 })).resolves.toBeTruthy();
  });

  it("supports rotation: a notification signed by both verifies with either secret", async () => {
    const both = header(T, SECRET, OLD);
    await expect(verify(both, [OLD])).resolves.toBeTruthy();
    await expect(verify(both, [SECRET])).resolves.toBeTruthy();
    await expect(verify(both, ["z".repeat(40)])).rejects.toMatchObject({ reason: "signature" });
  });

  it("refuses a genuinely signed body that is not JSON, or JSON that is not an object", async () => {
    for (const odd of ["not json at all", "null", "123", '"text"']) {
      const h = `t=${T},v1=${mac(SECRET, T, odd)}`;
      await expect(verifyWebhook(odd, h, SECRET, { now: T })).rejects.toMatchObject({ reason: "malformed" });
    }
  });

  it("refuses a body that is genuine but not a tuvl notification", async () => {
    const odd = '{"hello":"world"}';
    const h = `t=${T},v1=${mac(SECRET, T, odd)}`;
    await expect(verifyWebhook(odd, h, SECRET, { now: T })).rejects.toMatchObject({ reason: "malformed" });
    const bad = '{"id":"x","type":"run.exploded","created_at":"","workflow":"w","run_id":"r","seq":1}';
    await expect(verifyWebhook(bad, `t=${T},v1=${mac(SECRET, T, bad)}`, SECRET, { now: T })).rejects.toMatchObject({ reason: "malformed" });
  });

  it("is strict about how it is called", async () => {
    await expect(verifyWebhook({ id: "1" } as never, header(), SECRET, { now: T })).rejects.toThrow(/raw request body/);
    await expect(verifyWebhook(BODY, header(), [], { now: T })).rejects.toThrow(/at least one secret/);
    await expect(verifyWebhook(BODY, header(), "short", { now: T })).rejects.toThrow(/at least 32 bytes/);
  });
});

describe("webhookHandler", () => {
  const request = (h: string | null, body = BODY, method = "POST") =>
    new Request("https://app.example.com/hook", { method, body: method === "POST" ? body : undefined, headers: h ? { "tuvl-signature": h } : {} });
  const fresh = () => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${mac(SECRET, t, BODY)}`;
  };

  it("answers 204 and hands over a verified notification", async () => {
    const seen: string[] = [];
    const handle = webhookHandler({ secrets: SECRET, onNotification: (n) => void seen.push(n.id) });
    expect((await handle(request(fresh()))).status).toBe(204);
    expect(seen).toEqual(["3f2b8c1e-0000-4000-8000-000000000001"]);
  });

  it("answers a bare 401 / 400 / 405 and never calls the callback for a request it cannot trust", async () => {
    let called = 0;
    const handle = webhookHandler({ secrets: SECRET, onNotification: () => void called++ });
    const stale = await handle(request(`t=1,v1=${mac(SECRET, 1, BODY)}`));
    expect(stale.status).toBe(401);
    expect(await stale.text()).toBe("");
    expect((await handle(request(null))).status).toBe(400);
    expect((await handle(request(fresh(), BODY.replace("7", "9")))).status).toBe(401);
    expect((await handle(request(null, "", "GET"))).status).toBe(405);
    expect(called).toBe(0);
  });

  it("answers 500 when the callback fails, so the sender retries", async () => {
    const handle = webhookHandler({ secrets: SECRET, onNotification: () => { throw new Error("db down"); } });
    expect((await handle(request(fresh()))).status).toBe(500);
  });
});

describe("verifyWebhook body types", () => {
  it("accepts the raw body as an ArrayBuffer", async () => {
    const bytes = new TextEncoder().encode(BODY);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const n = await verifyWebhook(buffer, header(), SECRET, { now: T });
    expect(n.seq).toBe(7);
  });

  it("accepts the raw body as bytes", async () => {
    expect((await verifyWebhook(new TextEncoder().encode(BODY), header(), SECRET, { now: T })).seq).toBe(7);
  });

  it("rejects a parsed object", async () => {
    await expect(verifyWebhook({} as never, header(), SECRET, { now: T })).rejects.toThrow("raw request body");
  });
});

