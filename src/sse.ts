/**
 * SSE transport for @tuvl/client.
 *
 * Uses the Fetch API ReadableStream to parse SSE frames from a POST response
 * opened by Transport.postStream().  This avoids the browser's native
 * EventSource (which only supports GET) and works in Node 18+.
 *
 * Wire format produced by tuvl.core.engine.streaming:
 *
 *   event: step       data: {step_id, kind, signal, snapshot, duration_ms, error_detail}
 *   event: suspended  data: {<hitl_request payload>}
 *   event: done       data: {success, data, error}
 *   event: error      data: {message, details}
 *
 * The JSON body has NO `event_type` field — it lives only on the `event:`
 * line.  This parser injects the event name as `event_type` into the yielded
 * object so downstream consumers can switch on a single discriminator.
 */

import type { DoneEvent, ErrorEvent, StepEvent, SuspendedEvent } from "./types";

export type SseFrame = StepEvent | DoneEvent | ErrorEvent | SuspendedEvent;

/**
 * Parse an SSE stream from a Fetch Response body.
 *
 * Yields typed frames as they arrive.  The generator terminates when it
 * receives an event with event_type "done", "error", or "suspended", or
 * when the stream closes.
 */
export async function* parseSseStream(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  if (!response.body) {
    throw new Error("SSE response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let buffer = "";
  let currentEventType = "message";
  let currentDataLines: string[] = [];

  const flush = function* (): Generator<SseFrame> {
    const dataStr = currentDataLines.join("\n");
    const eventType = currentEventType;
    currentDataLines = [];
    currentEventType = "message";

    if (!dataStr) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      // Non-JSON data frame — skip silently
      return;
    }

    if (typeof parsed !== "object" || parsed === null) return;

    // Inject the SSE event name as the discriminator. The wire body itself
    // does not carry it (the server stamps it only on the `event:` line),
    // so downstream code cannot distinguish frames otherwise.
    const frame = { ...(parsed as Record<string, unknown>), event_type: eventType };
    yield frame as SseFrame;
  };

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // Last element may be incomplete — keep it in the buffer
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        // Trim a trailing \r in case the server (or proxy) emits CRLF.
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line.startsWith("event:")) {
          currentEventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentDataLines.push(line.slice(5).trim());
        } else if (line === "") {
          // End of frame
          for (const frame of flush()) {
            yield frame;
            if (
              frame.event_type === "done" ||
              frame.event_type === "error" ||
              frame.event_type === "suspended"
            ) {
              return;
            }
          }
        }
        // Comments (:) and retry: lines are intentionally ignored
      }
    }

    // Flush any remaining buffered frame
    for (const frame of flush()) {
      yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}
