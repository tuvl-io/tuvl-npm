/**
 * Shared types for @tuvl/client.
 *
 * These mirror the Python-side StepEvent dataclass and the system_router
 * manifest shapes to enable type-safe workflow invocation.
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
  /**
   * Role names extracted from all `group()` facts in the token.
   * These are the role names assigned to the user in the IAM database.
   * @example ["hr_manager", "member"]
   */
  groups: string[];
  /**
   * Permission scopes extracted from all `scope()` facts in the token.
   * These determine what workflows and admin endpoints the user may call.
   * @example ["requisition:write", "candidate:read"]
   */
  scopes: string[];
}

/** A single execution event streamed by the tuvl server. */
export interface StepEvent {
  /** "step" during execution, "done" on success, "error" on failure. */
  event_type: "step" | "done" | "error";
  /** Workflow step identifier (empty on "done"/"error"). */
  step_id: string;
  /** Step kind: "functional" | "agent" | "mcp" | "api_call" | "router" | "response" | "model-op" */
  kind: string;
  /** Routing signal returned by the step (e.g. "default", "yes", "no"). */
  signal: string;
  /** Snapshot of all public (non-underscore) context keys after this step. */
  snapshot: Record<string, unknown>;
  /** Elapsed wall time for this step in milliseconds. */
  duration_ms: number;
  /** Error message (only on event_type === "error"). */
  error_detail?: string;
}

/** Terminal event emitted when all steps complete successfully. */
export interface DoneEvent {
  event_type: "done";
  /** Final response payload (output_key or _response). */
  output: unknown;
}

/** Terminal event emitted when the workflow fails. */
export interface ErrorEvent {
  event_type: "error";
  message: string;
  details?: string;
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
export interface ExecuteOptions<TOutput = unknown> {
  /**
   * JSON body for the workflow trigger.  Must match the workflow's
   * input_schema.
   */
  payload?: Record<string, unknown>;

  /**
   * Called for each StepEvent received from the server (SSE / gRPC).
   * When provided alongside a workflow that has_slow_steps, the SDK
   * automatically switches to streaming mode.
   */
  onProgress?: (event: StepEvent) => void;

  /**
   * Force a specific transport:
   * - "sse"  — HTTP SSE (default when onProgress is set and has_slow_steps)
   * - "grpc" — gRPC-Web via sonora (requires peer dep)
   * - "rest" — plain JSON POST (default when no onProgress)
   */
  mode?: "sse" | "grpc" | "rest";

  /** Override the Bearer token for this specific call. */
  token?: string;

  /** Abort signal to cancel the request/stream. */
  signal?: AbortSignal;
}

/** Options passed to TuvlClient constructor. */
export interface TuvlClientOptions {
  /**
   * Base URL of the tuvl server (e.g. "http://localhost:8000").
   * Trailing slash is stripped automatically.
   */
  baseUrl: string;

  /**
   * Default Biscuit Bearer token injected on every request.
   * Can be overridden per-call in ExecuteOptions.token.
   */
  token?: string;

  /**
   * Time-to-live in milliseconds for cached workflow manifests.
   * Defaults to 60 000 ms (1 minute).  Set to 0 to disable caching.
   */
  manifestCacheTtl?: number;
}
