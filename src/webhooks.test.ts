import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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


describe("verifyWebhook limits", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A genuine notification of exactly `size` bytes: the agent name carries the padding. */
  const padded = (size: number) => {
    const note = JSON.parse(BODY) as Record<string, unknown>;
    const empty = new TextEncoder().encode(JSON.stringify({ ...note, agent: "" })).length;
    return JSON.stringify({ ...note, agent: "a".repeat(size - empty) });
  };
  const signed = (body: string) => `t=${T},v1=${mac(SECRET, T, body)}`;
  /** Candidates that have the right shape and match no secret. */
  const wrong = (count: number) => Array.from({ length: count }, (_, i) => `v1=${mac(`w${i}`.padEnd(40, "w"), T, BODY)}`);
  const hmacs = () => vi.spyOn(crypto.subtle, "verify");

  it("refuses a body over the limit before it computes any signature", async () => {
    const spy = hmacs();
    const big = padded(65_537);
    await expect(verifyWebhook(big, signed(big), SECRET, { now: T })).rejects.toMatchObject({ reason: "too_large" });
    await expect(verifyWebhook("x".repeat(10_000_000), signed(BODY), SECRET, { now: T })).rejects.toMatchObject({ reason: "too_large" });
    await expect(verifyWebhook(new Uint8Array(70_000), signed(BODY), SECRET, { now: T })).rejects.toMatchObject({ reason: "too_large" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts a body of exactly the limit", async () => {
    const body = padded(65_536);
    expect(new TextEncoder().encode(body).length).toBe(65_536);
    await expect(verifyWebhook(body, signed(body), SECRET, { now: T })).resolves.toMatchObject({ seq: 7 });
  });

  it("takes the limit from the options and insists on a sensible one", async () => {
    const size = new TextEncoder().encode(BODY).length;
    await expect(verifyWebhook(BODY, header(), SECRET, { now: T, maxBodyBytes: size - 1 })).rejects.toMatchObject({ reason: "too_large" });
    await expect(verifyWebhook(BODY, header(), SECRET, { now: T, maxBodyBytes: size })).resolves.toBeTruthy();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(verifyWebhook(BODY, header(), SECRET, { now: T, maxBodyBytes: bad })).rejects.toThrow(/maxBodyBytes/);
    }
  });

  it("refuses a signature header with more than ten candidates, or longer than 2 KB, without computing", async () => {
    const spy = hmacs();
    await expect(verify(`t=${T},${wrong(11).join(",")}`)).rejects.toMatchObject({ reason: "malformed" });
    await expect(verify(`${header()},pad=${"x".repeat(2100)}`)).rejects.toMatchObject({ reason: "malformed" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("still accepts ten candidates, the genuine one last", async () => {
    const spy = hmacs();
    await expect(verify(`t=${T},${wrong(9).join(",")},v1=${mac(SECRET, T, BODY)}`)).resolves.toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(10);
  });

  it("stops at the first match instead of checking every secret and candidate", async () => {
    const spy = hmacs();
    const h = `t=${T},v1=${mac(SECRET, T, BODY)},${wrong(8).join(",")}`;
    await expect(verify(h, [SECRET, OLD, "z".repeat(40)])).resolves.toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("webhookHandler limits", () => {
  const fresh = (body: string) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${mac(SECRET, t, body)}`;
  };
  const post = (body: BodyInit, h: string) =>
    new Request("https://app.example.com/hook", { method: "POST", body, headers: { "tuvl-signature": h }, duplex: "half" } as RequestInit);

  it("answers 413 for a body over the limit and never calls the callback", async () => {
    let called = 0;
    const handle = webhookHandler({ secrets: SECRET, onNotification: () => void called++ });
    const big = JSON.stringify({ ...JSON.parse(BODY), agent: "a".repeat(70_000) });
    const answer = await handle(post(big, fresh(big)));
    expect(answer.status).toBe(413);
    expect(await answer.text()).toBe("");
    expect(called).toBe(0);
  });

  it("uses its own limit when given one, and refuses a nonsensical one at creation", async () => {
    const handle = webhookHandler({ secrets: SECRET, onNotification: () => {}, maxBodyBytes: 100 });
    expect((await handle(post(BODY, fresh(BODY)))).status).toBe(413);
    expect(() => webhookHandler({ secrets: SECRET, onNotification: () => {}, maxBodyBytes: 0 })).toThrow(/maxBodyBytes/);
  });

  it("stops reading a huge body soon after the limit", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 10 * 1024 * 1024) return controller.close();
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const handle = webhookHandler({ secrets: SECRET, onNotification: () => {} });
    expect((await handle(post(stream, fresh(BODY)))).status).toBe(413);
    expect(pulled).toBeLessThan(256 * 1024);
  });

  it("still answers 413 when the sender's stream will not cancel", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(40 * 1024)),
      cancel: () => {
        throw new Error("the connection is already gone");
      },
    });
    const handle = webhookHandler({ secrets: SECRET, onNotification: () => {} });
    expect((await handle(post(stream, fresh(BODY)))).status).toBe(413);
  });

  it("lets a misconfigured handler fail loudly instead of answering as if the sender were at fault", async () => {
    const handle = webhookHandler({ secrets: [], onNotification: () => {} });
    await expect(handle(post(BODY, fresh(BODY)))).rejects.toThrow(/at least one secret/);
  });

  it("treats a POST with no body as malformed", async () => {
    const handle = webhookHandler({ secrets: SECRET, onNotification: () => {} });
    expect((await handle(new Request("https://app.example.com/hook", { method: "POST" }))).status).toBe(400);
  });

  it("reads a body that arrives in several chunks", async () => {
    const bytes = new TextEncoder().encode(BODY);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 50) controller.enqueue(bytes.slice(at, at + 50));
        controller.close();
      },
    });
    const seen: number[] = [];
    const handle = webhookHandler({ secrets: SECRET, onNotification: (n) => void seen.push(n.seq) });
    expect((await handle(post(stream, fresh(BODY)))).status).toBe(204);
    expect(seen).toEqual([7]);
  });
});
