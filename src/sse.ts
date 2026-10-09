/**
 * Server-Sent Events parsing for `GET /api/runs/{id}/events` (spec §15.2).
 *
 * Each frame is `id: <seq>`, `event: <type>`, `data: <RunEvent JSON>`; comment
 * lines (`: keep-alive`) are skipped. The stream ends when the server closes
 * it — after the run's last event when following.
 */

import type { RunEvent } from "./types";

/** Yield every event of an SSE response body, in order. */
export async function* parseSseStream(response: Response, signal?: AbortSignal): AsyncGenerator<RunEvent> {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let data: string[] = [];

  const flush = (): RunEvent | null => {
    const text = data.join("\n");
    data = [];
    if (!text) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null ? (parsed as RunEvent) : null;
    } catch {
      return null;
    }
  };

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
        else if (line === "") {
          const event = flush();
          if (event) yield event;
        }
      }
    }
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
