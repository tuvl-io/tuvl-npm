/**
 * Receive tuvl webhook notifications.
 *
 * A notification only says that a run reached a stage: the run's id, what happened, and a journal
 * position. It carries no input or output. Verify it, answer 2xx quickly, then pull what you need
 * with your own token — `client.run(id).get()` for the run, `.events({ fromSeq })` to catch up.
 *
 * Deliveries are at-least-once: the same `id` can arrive twice. De-duplicate on `id`.
 */

export type NotificationType =
  | "run.completed"
  | "run.failed"
  | "run.aborted"
  | "run.waiting"
  | "agent.completed";

export interface RunNotification {
  /** Stable across retries: the de-duplication key. */
  id: string;
  type: NotificationType;
  created_at: string;
  workflow: string;
  run_id: string;
  /** The run's journal position at this event: pull `events({ fromSeq: seq })` to read from here. */
  seq: number;
  /** The agent that finished (`agent.completed`) or is waiting (`run.waiting`). */
  agent?: string;
}

export type WebhookFailure = "malformed" | "signature" | "stale";

/** The request is not a genuine, fresh notification. Answer 4xx without saying why. */
export class WebhookError extends Error {
  constructor(readonly reason: WebhookFailure) {
    super(`tuvl webhook rejected: ${reason}`);
    this.name = "WebhookError";
  }
}

export interface VerifyOptions {
  /** Seconds either side of now a signature's timestamp may be (default 300). */
  toleranceSeconds?: number;
  /** Unix seconds; for tests. */
  now?: number;
}

const TYPES: ReadonlySet<string> = new Set([
  "run.completed",
  "run.failed",
  "run.aborted",
  "run.waiting",
  "agent.completed",
]);
const MIN_SECRET_BYTES = 32;
const encoder = new TextEncoder();

function bytes(raw: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof raw === "string") return encoder.encode(raw);
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new TypeError(
    "verifyWebhook needs the raw request body (a string or bytes), not a parsed object: " +
      "re-serialising changes the bytes and the signature no longer matches",
  );
}

function hex(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return undefined;
  const out = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function parse(signature: string): { timestamp: number; candidates: Uint8Array<ArrayBuffer>[] } | undefined {
  const timestamps: string[] = [];
  const candidates: Uint8Array<ArrayBuffer>[] = [];
  for (const part of signature.split(",")) {
    const at = part.indexOf("=");
    if (at < 0) return undefined;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t") timestamps.push(value);
    else if (key === "v1") {
      const decoded = hex(value);
      if (decoded) candidates.push(decoded);
    }
  }
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0]!) || candidates.length === 0) return undefined;
  return { timestamp: Number(timestamps[0]), candidates };
}

function shape(value: unknown): RunNotification | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const ok =
    typeof v.id === "string" &&
    typeof v.type === "string" &&
    TYPES.has(v.type) &&
    typeof v.created_at === "string" &&
    typeof v.workflow === "string" &&
    typeof v.run_id === "string" &&
    Number.isInteger(v.seq) &&
    (v.agent === undefined || typeof v.agent === "string");
  return ok ? (value as RunNotification) : undefined;
}

/**
 * Check a notification's signature and freshness and return it. Throws {@link WebhookError} when it
 * is not genuine: a wrong or missing signature, a body that was altered, a timestamp outside the
 * tolerance (a replay), or a body that is not a tuvl notification.
 *
 * `secrets` is every secret you currently accept: pass the new and the old one while rotating.
 * Works in Node 18+, Deno, Bun and edge runtimes (it uses Web Crypto).
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array | ArrayBuffer,
  signature: string | null | undefined,
  secrets: string | readonly string[],
  options: VerifyOptions = {},
): Promise<RunNotification> {
  const body = bytes(rawBody);
  const accepted = (typeof secrets === "string" ? [secrets] : [...secrets]).filter((s) => s !== "");
  if (accepted.length === 0) throw new TypeError("verifyWebhook needs at least one secret");
  if (accepted.some((s) => encoder.encode(s).length < MIN_SECRET_BYTES)) {
    throw new TypeError(`a webhook secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  const parsed = signature ? parse(signature) : undefined;
  if (!parsed) throw new WebhookError("malformed");

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > (options.toleranceSeconds ?? 300)) {
    throw new WebhookError("stale");
  }

  const signed = new Uint8Array([...encoder.encode(`${parsed.timestamp}.`), ...body]);
  let genuine = false;
  for (const secret of accepted) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    for (const candidate of parsed.candidates) {
      // subtle.verify compares in constant time
      if (await crypto.subtle.verify("HMAC", key, candidate, signed)) genuine = true;
    }
  }
  if (!genuine) throw new WebhookError("signature");

  let notification: RunNotification | undefined;
  try {
    notification = shape(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    notification = undefined;
  }
  if (!notification) throw new WebhookError("malformed");
  return notification;
}

export interface WebhookHandlerOptions {
  /** Every secret currently accepted (the new one and the old one while rotating). */
  secrets: string | readonly string[];
  /**
   * Called with a verified notification. Keep it quick (the sender waits for your answer): hand the
   * work to a queue, or pull the run without blocking. An error becomes a 500 so the sender retries.
   */
  onNotification: (notification: RunNotification) => void | Promise<void>;
  toleranceSeconds?: number;
}

/**
 * A `(Request) => Response` handler for runtimes built on the Fetch API (Next.js route handlers,
 * Cloudflare Workers, Deno, Bun, Hono). It reads the raw body itself, so the signature is checked
 * against the bytes that were signed. A request that fails verification gets a bare 400 or 401.
 *
 * @example
 * ```ts
 * export const POST = webhookHandler({
 *   secrets: [process.env.OPS_WEBHOOK_SECRET!],
 *   onNotification: async (n) => {
 *     if (seen.has(n.id)) return;            // at-least-once: de-duplicate
 *     seen.add(n.id);
 *     const run = await client.run(n.run_id).get(); // pull with your own token
 *     await pushToDevices(run);
 *   },
 * });
 * ```
 */
export function webhookHandler(options: WebhookHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = new Uint8Array(await request.arrayBuffer());
    let notification: RunNotification;
    try {
      notification = await verifyWebhook(body, request.headers.get("tuvl-signature"), options.secrets, {
        toleranceSeconds: options.toleranceSeconds,
      });
    } catch (error) {
      if (error instanceof WebhookError) return new Response(null, { status: error.reason === "malformed" ? 400 : 401 });
      throw error;
    }
    try {
      await options.onNotification(notification);
    } catch {
      return new Response(null, { status: 500 });
    }
    return new Response(null, { status: 204 });
  };
}
