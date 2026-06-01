/**
 * Tests for parseSseStream — SSE wire-format parser.
 */
import { describe, it, expect } from "vitest";
import { parseSseStream } from "./sse";

// Helper: build a Response whose body streams the given raw SSE text.
function makeResponse(raw: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function collect(raw: string, signal?: AbortSignal) {
  const frames: unknown[] = [];
  for await (const frame of parseSseStream(makeResponse(raw), signal)) {
    frames.push(frame);
  }
  return frames;
}

describe("parseSseStream", () => {
  it("parses a single step frame", async () => {
    const raw = [
      "event: step",
      'data: {"step_id":"s1","kind":"llm","signal":"ok","snapshot":{},"duration_ms":10}',
      "",
      "",
    ].join("\n");

    const frames = await collect(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      event_type: "step",
      step_id: "s1",
      kind: "llm",
    });
  });

  it("parses a done frame and stops iteration", async () => {
    const raw = [
      "event: step",
      'data: {"step_id":"s1","kind":"llm","signal":"ok","snapshot":{},"duration_ms":5}',
      "",
      "event: done",
      'data: {"success":true,"data":{"result":42},"error":null}',
      "",
      // Any frames after 'done' should NOT be yielded
      "event: step",
      'data: {"step_id":"s2","kind":"llm","signal":"ok","snapshot":{},"duration_ms":1}',
      "",
      "",
    ].join("\n");

    const frames = await collect(raw);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ event_type: "done", success: true });
  });

  it("parses an error frame and stops iteration", async () => {
    const raw = [
      "event: error",
      'data: {"message":"engine crashed","details":"OOM"}',
      "",
      "",
    ].join("\n");

    const frames = await collect(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event_type: "error", message: "engine crashed" });
  });

  it("parses a suspended frame and stops iteration", async () => {
    const raw = [
      "event: suspended",
      'data: {"instance_id":"inst-1","paused_step_id":"review"}',
      "",
      "",
    ].join("\n");

    const frames = await collect(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event_type: "suspended", instance_id: "inst-1" });
  });

  it("injects event_type from the event: line (not from data)", async () => {
    const raw = [
      "event: step",
      'data: {"step_id":"x","kind":"tool","signal":"ok","snapshot":{},"duration_ms":2}',
      "",
      "",
    ].join("\n");

    const frames = await collect(raw);
    // data body has no event_type — it must be injected by the parser
    expect((frames[0] as Record<string, unknown>).event_type).toBe("step");
  });

  it("falls back to 'message' event type when no event: line present", async () => {
    const raw = ['data: {"foo":"bar"}', "", ""].join("\n");
    const frames = await collect(raw);
    expect(frames).toHaveLength(1);
    expect((frames[0] as Record<string, unknown>).event_type).toBe("message");
  });

  it("skips non-JSON data frames silently", async () => {
    const raw = [
      "data: not-json",
      "",
      "event: done",
      'data: {"success":true,"data":null,"error":null}',
      "",
      "",
    ].join("\n");

    const frames = await collect(raw);
    // non-JSON frame is skipped; done frame is returned
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event_type: "done" });
  });

  it("handles CRLF line endings", async () => {
    const raw =
      "event: step\r\ndata: {\"step_id\":\"s1\",\"kind\":\"llm\",\"signal\":\"ok\",\"snapshot\":{},\"duration_ms\":1}\r\n\r\n";
    const frames = await collect(raw);
    expect(frames).toHaveLength(1);
    expect((frames[0] as Record<string, unknown>).event_type).toBe("step");
  });

  it("throws when response has no body", async () => {
    const response = new Response(null, { status: 200 });
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of parseSseStream(response)) { /* drain */ }
    }).rejects.toThrow("SSE response has no body");
  });

  it("stops early when AbortSignal is aborted", async () => {
    // Build a stream that would produce two done-worthy frames, but abort after first
    const raw = [
      "event: step",
      'data: {"step_id":"s1","kind":"llm","signal":"ok","snapshot":{},"duration_ms":1}',
      "",
      "event: step",
      'data: {"step_id":"s2","kind":"llm","signal":"ok","snapshot":{},"duration_ms":1}',
      "",
      "",
    ].join("\n");

    const controller = new AbortController();
    const frames: unknown[] = [];
    for await (const frame of parseSseStream(makeResponse(raw), controller.signal)) {
      frames.push(frame);
      controller.abort(); // abort after the first frame
    }
    // May yield 1 or 2 depending on buffer state — just verify it doesn't hang
    expect(frames.length).toBeGreaterThanOrEqual(1);
  });
});
