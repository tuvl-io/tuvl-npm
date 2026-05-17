/**
 * SSE transport for @tuvl/client.
 *
 * Uses the Fetch API ReadableStream to parse SSE frames from a POST response
 * opened by Transport.postStream().  This avoids the browser's native
 * EventSource (which only supports GET) and works in Node 18+.
 */

import type { DoneEvent, ErrorEvent, StepEvent } from "./types";

export type SseFrame = StepEvent | DoneEvent | ErrorEvent;

/**
 * Parse an SSE stream from a Fetch Response body.
 *
 * Yields typed frames as they arrive.  The generator terminates when it
 * receives an event with event_type "done" or "error", or when the stream
 * closes.
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
    currentDataLines = [];
    const eventType = currentEventType;
    currentEventType = "message";

    if (!dataStr) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      // Non-JSON data frame — skip silently
      return;
    }

    if (typeof parsed === "object" && parsed !== null) {
      yield parsed as SseFrame;
    }
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

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentDataLines.push(line.slice(5).trim());
        } else if (line === "") {
          // End of frame
          for (const frame of flush()) {
            yield frame;
            if (
              typeof frame === "object" &&
              frame !== null &&
              "event_type" in frame &&
              (frame.event_type === "done" || frame.event_type === "error")
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
