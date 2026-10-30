import { describe, expect, it } from "vitest";
import { parseSseEvents, parseSseStream } from "./sse";
import type { RunEvent } from "./types";

function stream(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  );
}

const event = (seq: number, type: string): RunEvent => ({
  run_id: "r1",
  seq,
  ts: "2026-10-09T00:00:00Z",
  type,
  agent_id: seq === 2 ? "classify" : null,
  engine: seq === 2 ? "llm" : null,
  tokens: null,
  latency_ms: null,
  payload: {},
});

const frame = (e: RunEvent) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

async function collect(response: Response): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of parseSseStream(response)) out.push(e);
  return out;
}

const delta = (agent: string, text: string, replay = false) =>
  `event: token_delta\ndata: ${JSON.stringify({ run_id: "r1", agent_id: agent, delta: text, replay })}\n\n`;
const reset = (agent: string) => `event: token_reset\ndata: ${JSON.stringify({ run_id: "r1", agent_id: agent })}\n\n`;

describe("live drafts", () => {
  const text = frame(event(1, "run_started")) + delta("classify", "Hel") + delta("classify", "lo") + reset("classify") + frame(event(2, "agent_started"));

  it("parseSseStream still yields only journal events", async () => {
    const events = await collect(stream(text));
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, "run_started"],
      [2, "agent_started"],
    ]);
  });

  it("parseSseEvents yields drafts in order, typed by the frame's event name", async () => {
    const out = [];
    for await (const e of parseSseEvents(stream(text.slice(0, 77), text.slice(77)))) out.push(e);
    expect(out.map((e) => e.type)).toEqual(["run_started", "token_delta", "token_delta", "token_reset", "agent_started"]);
    expect(out[1]).toMatchObject({ agent_id: "classify", delta: "Hel", replay: false });
    expect(out[3]).toEqual({ type: "token_reset", run_id: "r1", agent_id: "classify" });
  });

  it("a frame with no event name is a journal event", async () => {
    const out = [];
    for await (const e of parseSseEvents(stream(`data: ${JSON.stringify(event(5, "run_completed"))}\n\n`))) out.push(e);
    expect(out.map((e) => e.type)).toEqual(["run_completed"]);
  });
});

describe("parseSseStream", () => {
  it("yields run events across chunk boundaries and skips keep-alives", async () => {
    const text = frame(event(1, "run_started")) + ": keep-alive\n\n" + frame(event(2, "agent_started"));
    const events = await collect(stream(text.slice(0, 30), text.slice(30, 95), text.slice(95)));
    expect(events.map((e) => [e.seq, e.type, e.agent_id])).toEqual([
      [1, "run_started", null],
      [2, "agent_started", "classify"],
    ]);
  });

  it("handles CRLF, a final frame without a blank line, and bad JSON", async () => {
    const crlf = frame(event(1, "run_started")).replace(/\n/g, "\r\n");
    const events = await collect(stream(crlf, "data: not json\n\n", `data: ${JSON.stringify(event(3, "run_completed"))}`));
    expect(events.map((e) => e.type)).toEqual(["run_started", "run_completed"]);
  });

  it("rejects a response without a body", async () => {
    await expect(collect(new Response(null))).rejects.toThrow("no body");
  });
});
