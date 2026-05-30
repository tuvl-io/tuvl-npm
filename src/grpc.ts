/**
 * gRPC-Web transport for @tuvl/client.
 *
 * This module is an OPTIONAL transport that requires the peer dependencies:
 *   @protobuf-ts/grpcweb-transport
 *   @protobuf-ts/runtime-rpc
 *
 * It uses dynamic import() so the main bundle has zero overhead if you never
 * use mode="grpc".  The protobuf definitions are created inline rather than
 * from generated stubs, keeping the SDK self-contained (no make proto step
 * required on the client side).
 *
 * The wire format matches execution.proto:
 *   service ExecutionService { rpc RunWorkflow(RunRequest) → stream StepEvent }
 */

/**
 * gRPC StepEvent on the wire. Unlike the typed SSE `StepEvent` (which is
 * narrowed to `event_type: "step"`), this can carry "step" | "done" |
 * "error" | "suspended" — the discriminator the servicer chose.
 */
export interface GrpcStepEvent {
  event_type: "step" | "done" | "error" | "suspended";
  step_id: string;
  kind: string;
  signal: string;
  /** Decoded from `snapshot_json` on the wire. */
  snapshot: Record<string, unknown>;
  duration_ms: number;
  error_detail?: string;
}

export interface GrpcRunOptions {
  baseUrl: string;
  workflowName: string;
  payloadJson: string;
  tokenFallback?: string;
  token?: string;
  signal?: AbortSignal;
}

/**
 * Open a gRPC-Web server-streaming call to ExecutionService.RunWorkflow.
 *
 * Yields `GrpcStepEvent` objects (with `snapshot_json` already parsed into
 * `snapshot`).  The caller decides what each `event_type` means.
 *
 * Throws if the peer deps are not installed.
 */
export async function* openGrpcStream(
  options: GrpcRunOptions,
): AsyncGenerator<GrpcStepEvent> {
  // Dynamically import peer deps — zero cost when not used
  let GrpcWebFetchTransport: { new (opts: { baseUrl: string }): unknown };
  try {
    const mod = await import("@protobuf-ts/grpcweb-transport");
    GrpcWebFetchTransport = (mod as { GrpcWebFetchTransport: typeof GrpcWebFetchTransport }).GrpcWebFetchTransport;
  } catch {
    throw new Error(
      "@tuvl/client: gRPC mode requires @protobuf-ts/grpcweb-transport. " +
        "Install it with: npm i @protobuf-ts/grpcweb-transport @protobuf-ts/runtime-rpc",
    );
  }

  const { BinaryWriter, BinaryReader, WireType } = await import(
    "@protobuf-ts/runtime"
  );

  // ── Minimal inline protobuf encode/decode for RunRequest / StepEvent ───────

  function encodeRunRequest(
    workflowName: string,
    payloadJson: string,
    tokenFallback: string,
  ): Uint8Array {
    const writer = new BinaryWriter();
    writer.tag(1, WireType.LengthDelimited).string(workflowName);
    writer.tag(2, WireType.LengthDelimited).string(payloadJson);
    if (tokenFallback) {
      writer.tag(3, WireType.LengthDelimited).string(tokenFallback);
    }
    return writer.finish();
  }

  function decodeStepEvent(bytes: Uint8Array): GrpcStepEvent {
    const reader = new BinaryReader(bytes);
    let eventType = "";
    let stepId = "";
    let kind = "";
    let signal = "";
    let snapshotJson = "";
    let durationMs = 0;
    let errorDetail = "";

    while (reader.pos < reader.len) {
      const [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case 1: eventType = reader.string(); break;
        case 2: stepId = reader.string(); break;
        case 3: kind = reader.string(); break;
        case 4: signal = reader.string(); break;
        case 5: snapshotJson = reader.string(); break;
        case 6: durationMs = reader.float(); break;
        case 7: errorDetail = reader.string(); break;
        default: reader.skip(wireType);
      }
    }

    let snapshot: Record<string, unknown> = {};
    if (snapshotJson) {
      try {
        snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
      } catch {
        // ignore malformed snapshot
      }
    }

    // Default to "step" if the server didn't stamp event_type (shouldn't happen
    // — every emitted message sets the field — but stay defensive).
    const et = (eventType || "step") as GrpcStepEvent["event_type"];

    return {
      event_type: et,
      step_id: stepId,
      kind,
      signal,
      snapshot,
      duration_ms: durationMs,
      error_detail: errorDetail || undefined,
    };
  }

  // ── gRPC-Web call ─────────────────────────────────────────────────────────

  const transport = new (GrpcWebFetchTransport as { new (opts: { baseUrl: string; fetchInit?: RequestInit }): { serverStreaming: (descriptor: unknown, input: unknown, options?: unknown) => { responses: AsyncIterable<Uint8Array> } } })({
    baseUrl: options.baseUrl,
    fetchInit: options.token
      ? { headers: { Authorization: `Bearer ${options.token}` } }
      : undefined,
  });

  const methodDescriptor = {
    name: "/tuvl.v1.ExecutionService/RunWorkflow",
    clientStreaming: false,
    serverStreaming: true,
    I: { create: () => ({}) } as unknown,
    O: { create: () => ({}) } as unknown,
    options: {},
  };

  const requestBytes = encodeRunRequest(
    options.workflowName,
    options.payloadJson,
    options.tokenFallback ?? "",
  );

  const call = transport.serverStreaming(methodDescriptor, requestBytes, {
    abort: options.signal,
  });

  for await (const responseBytes of call.responses) {
    const event = decodeStepEvent(responseBytes as Uint8Array);
    yield event;
    if (
      event.event_type === "done" ||
      event.event_type === "error" ||
      event.event_type === "suspended"
    ) {
      break;
    }
  }
}
