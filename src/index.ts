/**
 * @tuvl/client — TypeScript client SDK for the tuvl workflow engine.
 *
 * @example
 * ```ts
 * import { TuvlClient } from "@tuvl/client";
 *
 * const client = new TuvlClient({ baseUrl: "http://localhost:8000", token });
 *
 * // Plain REST call
 * const result = await client.execute("my-workflow", { payload: { id: 1 } });
 *
 * // SSE streaming (auto-detected when onProgress is provided)
 * const result = await client.execute("my-workflow", {
 *   payload: { id: 1 },
 *   onProgress: (ev) => console.log(`[${ev.step_id}] ${ev.signal} (${ev.duration_ms}ms)`),
 * });
 * ```
 */

export { TuvlClient } from "./client";
export { TuvlAuth } from "./auth";
export { parseSseStream } from "./sse";
export { openGrpcStream } from "./grpc";
export { Transport } from "./transport";
export type {
  TokenResponse,
  StepEvent,
  DoneEvent,
  ErrorEvent,
  WorkflowManifest,
  WorkflowManifestMap,
  ExecuteOptions,
  TuvlClientOptions,
} from "./types";
