/**
 * Shared types for @tuvl/client.
 *
 * Mirrors the Python-side StepEvent dataclass, the SSE envelope produced by
 * tuvl.core.engine.streaming, and the system_router manifest shapes.
 */

/** Returned by all /auth/* login and refresh endpoints. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
}

/**
 * Decoded identity and permissions for the currently authenticated user.
 * Returned by GET /auth/me.
 */
export interface MeResponse {
  /** User UUID extracted from the `user()` Datalog fact in the token. */
  user_id: string;
  /** Role names from all `group()` facts — e.g. ["hr_manager", "member"]. */
  groups: string[];
  /** Permission scopes from all `scope()` facts — e.g. ["candidate:read"]. */
  scopes: string[];
}

/** A single execution event streamed by the tuvl server (SSE or gRPC). */
export interface StepEvent {
  event_type: "step";
  step_id: string;
  kind: string;
  signal: string;
  snapshot: Record<string, unknown>;
  duration_ms: number;
  error_detail?: string | null;
}

/**
 * Terminal event emitted when the workflow finishes (success OR business failure).
 * Wire shape from tuvl.core.api.manager._sse_generator:
 *   {success: true,  data: <output>,  error: null}
 *   {success: false, data: <partial>, error: {...workflow error...}}
 */
export interface DoneEvent {
  event_type: "done";
  success: boolean;
  data: unknown;
  error: WorkflowErrorPayload | null;
}

/** Terminal event emitted when the workflow engine itself raised an exception. */
export interface ErrorEvent {
  event_type: "error";
  message: string;
  details?: string | null;
}

/** Terminal event emitted when a workflow hits a Human-in-the-Loop step. */
export interface SuspendedEvent {
  event_type: "suspended";
  instance_id?: string;
  paused_step_id?: string;
  ui?: unknown;
  schema?: unknown;
  context_data?: Record<string, unknown>;
  output_key?: string;
  [key: string]: unknown;
}

/** Shape of the `error` field on a non-success DoneEvent / REST envelope. */
export interface WorkflowErrorPayload {
  code?: string;
  message?: string;
  details?: unknown;
  [key: string]: unknown;
}

/**
 * Shape of the plain REST response body returned by
 * `POST <workflow_trigger_path>` (and the versioned variant).
 *
 * `execute()` unwraps this and returns just `data` on success, throwing
 * `TuvlWorkflowError` on `success === false`.
 */
export interface RestEnvelope<TData = unknown> {
  success: boolean;
  status_code: number;
  data: TData | null;
  error: WorkflowErrorPayload | null;
}

/** Manifest for a single workflow (from GET /api/_system/workflows/{name}). */
export interface WorkflowManifest {
  name: string;
  trigger_path: string;
  trigger_method: string;
  has_slow_steps: boolean;
  slow_kinds_present: string[];
  required_scope: string | null;
  required_group: string | null;
  steps: Array<{ id: string; kind: string }>;
}

/** Map of workflow manifests (from GET /api/_system/workflows). */
export type WorkflowManifestMap = Record<string, Omit<WorkflowManifest, "name" | "steps">>;

/** Options passed to TuvlClient.execute(). */
export interface ExecuteOptions<_TOutput = unknown> {
  payload?: Record<string, unknown>;
  onProgress?: (event: StepEvent) => void;
  onSuspended?: (event: SuspendedEvent) => void;
  mode?: "sse" | "grpc" | "rest";
  token?: string;
  signal?: AbortSignal;
}

/** Options passed to TuvlClient.executeVersioned(). */
export interface ExecuteVersionedOptions<_TOutput = unknown> extends ExecuteOptions<_TOutput> {
  /** The workflow's schema_version, e.g. "v2". Calls /{version}/run/{name}. */
  version: string;
}

/** Body sent to POST /api/workflows/resume. */
export interface ResumeRequest {
  instance_id: string;
  human_input?: Record<string, unknown>;
}

/** Options passed to TuvlClient.resumeWorkflow(). */
export interface ResumeOptions<_TOutput = unknown> {
  instanceId: string;
  humanInput?: Record<string, unknown>;
  onProgress?: (event: StepEvent) => void;
  onSuspended?: (event: SuspendedEvent) => void;
  mode?: "sse" | "rest";
  token?: string;
  signal?: AbortSignal;
}

/** Options passed to TuvlClient constructor. */
export interface TuvlClientOptions {
  baseUrl: string;
  token?: string;
  manifestCacheTtl?: number;
}

// ── CRUD types ────────────────────────────────────────────────────────────────

/**
 * Options for listing records from a CRUD model endpoint.
 *
 * `filters` maps to bracket-notation query params: `filter[key]=value`.
 * `include` maps to `?include=relation1,relation2` for eager-loading relations.
 */
export interface CrudListOptions {
  limit?: number;
  offset?: number;
  /** Server-side field filters: { stage: "screening" } → `?filter[stage]=screening` */
  filters?: Record<string, string>;
  /** Relation names to embed: ["posting"] → `?include=posting` */
  include?: string[];
  token?: string;
  signal?: AbortSignal;
}

/** Options for retrieving a single CRUD record. */
export interface CrudGetOptions {
  /** Relation names to embed: ["candidate"] → `?include=candidate` */
  include?: string[];
  token?: string;
  signal?: AbortSignal;
}

/** Options for create / update / delete calls. */
export interface CrudMutateOptions {
  token?: string;
  signal?: AbortSignal;
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Thrown by `execute()` when a workflow finishes with `success: false`.
 */
export class TuvlWorkflowError extends Error {
  readonly data: unknown;
  readonly error: WorkflowErrorPayload | null;
  constructor(message: string, data: unknown, error: WorkflowErrorPayload | null) {
    super(message);
    this.name = "TuvlWorkflowError";
    this.data = data;
    this.error = error;
  }
}

/**
 * Thrown by `execute()` when a workflow suspends at a Human-in-the-Loop step.
 */
export class TuvlWorkflowSuspendedError extends Error {
  readonly suspended: SuspendedEvent;
  constructor(suspended: SuspendedEvent) {
    super(`tuvl workflow suspended at step '${suspended.paused_step_id ?? "?"}'`);
    this.name = "TuvlWorkflowSuspendedError";
    this.suspended = suspended;
  }
}
