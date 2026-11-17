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

export type WebhookFailure = "malformed" | "signature" | "stale" | "too_large";

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
  /** The most bytes of body that are hashed (default 65 536). A notification is a few hundred bytes; a bigger body is `too_large`. */
  maxBodyBytes?: number;
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
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
// The engine signs once per secret (two while rotating): a longer header, or one with more candidates, is not its.
const MAX_SIGNATURE_CHARS = 2048;
const MAX_CANDIDATES = 10;
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

function bodyLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("maxBodyBytes must be a positive integer");
  return limit;
}

function parse(signature: string): { timestamp: number; candidates: Uint8Array<ArrayBuffer>[] } | undefined {
  if (signature.length > MAX_SIGNATURE_CHARS) return undefined;
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
      if (candidates.length > MAX_CANDIDATES) return undefined;
    }
  }
  const [timestamp] = timestamps;
  if (timestamps.length !== 1 || timestamp === undefined || !/^\d+$/.test(timestamp) || candidates.length === 0) {
    return undefined;
  }
  return { timestamp: Number(timestamp), candidates };
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

/** Whether any candidate signs `signed` with any secret; it stops at the first match. */
async function genuine(
  signed: Uint8Array<ArrayBuffer>,
  secrets: string[],
  candidates: Uint8Array<ArrayBuffer>[],
): Promise<boolean> {
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    for (const candidate of candidates) {
      // subtle.verify compares in constant time
      if (await crypto.subtle.verify("HMAC", key, candidate, signed)) return true;
    }
  }
  return false;
}

/**
 * Check a notification's signature and freshness and return it. Throws {@link WebhookError} when it
 * is not genuine: a wrong or missing signature, a body that was altered, a timestamp outside the
 * tolerance (a replay), a body over `maxBodyBytes`, or a body that is not a tuvl notification.
 *
 * `secrets` is every secret you currently accept: pass the new and the old one while rotating.
 * Works in Node 22+, Deno, Bun and edge runtimes (it uses Web Crypto).
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array | ArrayBuffer,
  signature: string | null | undefined,
  secrets: string | readonly string[],
  options: VerifyOptions = {},
): Promise<RunNotification> {
  const limit = bodyLimit(options.maxBodyBytes);
  if (typeof rawBody === "string" && rawBody.length > limit) throw new WebhookError("too_large"); // its bytes are at least as many
  const body = bytes(rawBody);
  if (body.length > limit) throw new WebhookError("too_large");
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

  const prefix = encoder.encode(`${parsed.timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  if (!(await genuine(signed, accepted, parsed.candidates))) throw new WebhookError("signature");

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
  /** The most bytes of body to accept (default 65 536). A bigger one is answered 413 and not read further. */
  maxBodyBytes?: number;
}

const STATUS: Record<WebhookFailure, number> = { malformed: 400, signature: 401, stale: 401, too_large: 413 };

/** The request body, read only as far as `limit`: `undefined` when it is bigger, and the rest is never read. */
async function readBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/**
 * A `(Request) => Response` handler for runtimes built on the Fetch API (Next.js route handlers,
 * Cloudflare Workers, Deno, Bun, Hono). It reads the raw body itself, so the signature is checked
 * against the bytes that were signed. A request that fails verification gets a bare 400 or 401, and a body
 * over `maxBodyBytes` a bare 413 without being read to the end.
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
  const limit = bodyLimit(options.maxBodyBytes);
  return async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await readBody(request, limit);
    if (!body) return new Response(null, { status: STATUS.too_large });
    let notification: RunNotification;
    try {
      notification = await verifyWebhook(body, request.headers.get("tuvl-signature"), options.secrets, {
        toleranceSeconds: options.toleranceSeconds,
        maxBodyBytes: limit,
      });
    } catch (error) {
      if (error instanceof WebhookError) return new Response(null, { status: STATUS[error.reason] });
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
