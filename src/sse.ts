/**
 * Server-Sent Events parsing for `GET /api/runs/{id}/events` (spec §15.2).
 *
 * Each frame is `id: <seq>`, `event: <type>`, `data: <JSON>`; comment lines (`: keep-alive`) are
 * skipped. The stream ends when the server closes it — after the run's last event when following.
 *
 * With `drafts=true` the server also sends `token_delta` and `token_reset` frames: not journal events
 * (no `id`, `seq` or `ts`). {@link parseSseStream} yields only journal events, as it always has;
 * {@link parseSseEvents} yields both.
 */

import type { RunEvent, RunStreamEvent, TokenDelta, TokenReset } from "./types";

const TOKEN_FRAMES = new Set(["token_delta", "token_reset"]);

interface Frame {
  name: string;
  data: Record<string, unknown>;
}

async function* frames(response: Response, signal?: AbortSignal): AsyncGenerator<Frame> {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let name = "";
  let data: string[] = [];

  const flush = (): Frame | null => {
    const text = data.join("\n");
    const frameName = name;
    data = [];
    name = "";
    if (!text) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null
        ? { name: frameName, data: parsed as Record<string, unknown> }
        : null;
    } catch {
      return null;
    }
  };

  // an abort must not wait for the next chunk: cancelling the reader ends the pending read
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line === "") {
          const frame = flush();
          if (frame) yield frame;
        }
      }
    }
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
    const last = flush();
    if (last) yield last;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // leaving early (a `break`, a throw) must close the connection, not just let go of it
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Yield every journal event of an SSE response body, in order (live drafts are skipped). */
export async function* parseSseStream(response: Response, signal?: AbortSignal): AsyncGenerator<RunEvent> {
  for await (const frame of frames(response, signal)) {
    if (!TOKEN_FRAMES.has(frame.name)) yield frame.data as unknown as RunEvent;
  }
}

/** Yield journal events and live drafts (`token_delta`, `token_reset`), in order. */
export async function* parseSseEvents(response: Response, signal?: AbortSignal): AsyncGenerator<RunStreamEvent> {
  for await (const frame of frames(response, signal)) {
    if (frame.name === "token_delta") yield { ...frame.data, type: "token_delta" } as unknown as TokenDelta;
    else if (frame.name === "token_reset") yield { ...frame.data, type: "token_reset" } as unknown as TokenReset;
    else yield frame.data as unknown as RunEvent;
  }
}
