/**
 * Riding out a connection that drops or a server that says "not now": which failures another try can cure, how long to
 * wait before it, and a sleep that an abort can end.
 */

import { TuvlApiError } from "./types";

/** Consecutive transient failures a followed stream or `wait()` rides out before it gives up. */
export const MAX_TRANSIENT = 5;

/** The longest a `Retry-After` is honoured for; a server asking for more is not going to be waited out here. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Wait `ms`, or reject as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A failure another try may cure: the connection dropped (`fetch` rejects with a `TypeError`), or the server answered 408, 425, 429 or 5xx. */
export function transient(error: unknown): boolean {
  if (error instanceof TuvlApiError) return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError;
}

/** `ms` with up to 10% either way, so that clients that failed together do not all come back together. */
export function jitter(ms: number): number {
  return Math.round(ms * (0.9 + 0.2 * Math.random()));
}

/** The pause before try number `attempt` (1 is the first retry): `base`, doubling, at most `cap`, and at least what the server asked for. */
export function pause(attempt: number, error: unknown, base: number, cap: number): number {
  const own = jitter(Math.min(cap, base * 2 ** (attempt - 1)));
  const asked = error instanceof TuvlApiError && error.retryAfter !== undefined ? error.retryAfter * 1000 : 0;
  return Math.max(own, Math.min(asked, MAX_RETRY_AFTER_MS));
}
