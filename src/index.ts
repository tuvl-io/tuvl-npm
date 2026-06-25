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
export type { TuvlAuthOptions, BootstrapRequest } from "./auth";
export { CrudClient } from "./crud";
export { parseSseStream } from "./sse";
export { openGrpcStream } from "./grpc";
export { Transport } from "./transport";
export {
  TuvlWorkflowError,
  TuvlWorkflowSuspendedError,
  agentProgress,
} from "./types";
export type {
  TokenResponse,
  MeResponse,
  StepEvent,
  AgentProgress,
  DoneEvent,
  ErrorEvent,
  SuspendedEvent,
  WorkflowErrorPayload,
  RestEnvelope,
  WorkflowManifest,
  WorkflowManifestMap,
  ExecuteOptions,
  ExecuteVersionedOptions,
  ResumeOptions,
  ResumeRequest,
  TuvlClientOptions,
  CrudListOptions,
  CrudGetOptions,
  CrudMutateOptions,
} from "./types";
