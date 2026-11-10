/**
 * Shared types for @tuvl/client 2.0 (REST + SSE, spec §15).
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
  /** User id (the token's `sub` claim). */
  user_id: string;
  /** Role names (the `groups` claim) — e.g. ["hr_manager", "member"]. */
  groups: string[];
  /** Permission scopes (the `scopes` claim) — e.g. ["candidate:read"]. */
  scopes: string[];
}


// ── Roles (the `roles` API group, tuvl >= 2.1.0b2) ───────────────────────────

/** A role as `GET /auth/roles` lists it. `scopes` is read-only here; it is set in the project. */
export interface Role {
  id: string;
  name: string;
  description: string | null;
  /** A disabled role keeps its members and scopes but grants nothing. */
  is_active: boolean;
  scopes: string[];
  member_count: number;
}

/** A user as the member and user-picker lists show them: no roles, no permissions. */
export interface RoleMember {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  is_active: boolean;
}

/** One page of a list; pass `next_cursor` as `cursor` for the next, `null` on the last. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ── Runs (spec §15.1) ─────────────────────────────────────────────────────────

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_human"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "aborted"
  | "compensated";

export const TERMINAL_STATUSES: readonly RunStatus[] = ["completed", "failed", "aborted", "compensated"];
export const WAITING_STATUSES: readonly RunStatus[] = ["waiting_human", "waiting_approval", "paused"];

/** A pending human form or tool-call approval (`GET /api/approvals`). */
/** One webhook notification of a run (`client.runs.webhooks`). */
export interface WebhookDelivery {
  id: string;
  webhook: string;
  type: string;
  seq: number;
  agent: string | null;
  status: "pending" | "delivered" | "dead";
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface Approval {
  approval_id: string;
  run_id: string;
  agent_id: string;
  kind: "human" | "tool" | "pause";
  status: string;
  required_group: string | null;
  expires_at: string | null;
  created_at: string | null;
  decide_url: string;
  title?: string;
  instruction?: string | null;
  show?: Record<string, unknown>;
  form?: Record<string, { type: string; required: boolean; label?: string; widget?: string; help?: string }>;
  tool?: string;
  args?: Record<string, unknown>;
  reason?: string;
  [key: string]: unknown;
}

/** `GET /api/runs/{id}` and the `202` body of a trigger. */
export interface Run {
  run_id: string;
  workflow: string;
  status: RunStatus;
  trigger: string;
  current_agent: string | null;
  end: string | null;
  output: { status: number; body: unknown } | null;
  error: string | Record<string, unknown> | null;
  tokens_used: number;
  created_at: string | null;
  updated_at: string | null;
  status_url: string;
  events_url: string;
  approval?: Approval;
}

/** Journal event types (spec Appendix C.3). */
export type RunEventType =
  | "run_queued"
  | "run_started"
  | "agent_started"
  | "agent_completed"
  | "signal"
  | "llm_turn"
  | "tool_call"
  | "tool_result"
  | "decision"
  | "judge_verdict"
  | "approval_requested"
  | "approval_decided"
  | "paused"
  | "resumed"
  | "checkpoint"
  | "compensation_started"
  | "compensation_completed"
  | "run_completed"
  | "run_failed"
  | "run_aborted";

/** One SSE event of `GET /api/runs/{id}/events` (spec §15.2). */
export interface RunEvent {
  run_id: string;
  seq: number;
  ts: string | null;
  /** A {@link RunEventType}; kept open so newer servers don't break older clients. */
  type: RunEventType | (string & {});
  agent_id: string | null;
  engine: string | null;
  tokens: number | null;
  latency_ms: number | null;
  payload: Record<string, unknown>;
}

/**
 * A piece of an agent's answer while the model is still writing it (`token_delta`). Not a journal event:
 * it has no `seq`. `replay` is true for the draft so far, sent once to a client that joined mid-agent.
 */
export interface TokenDelta {
  type: "token_delta";
  run_id: string;
  agent_id: string;
  delta: string;
  replay: boolean;
}

/** The agent is starting its answer again (a retry, or a failure): discard the draft (`token_reset`). */
export interface TokenReset {
  type: "token_reset";
  run_id: string;
  agent_id: string;
}

export type TokenEvent = TokenDelta | TokenReset;

/** Whether a streamed item is a live draft rather than a journal event. */
export function isTokenEvent(event: { type: string }): event is TokenEvent {
  return event.type === "token_delta" || event.type === "token_reset";
}

/** What `stream()` yields: journal events and live drafts, told apart by `type`. */
export type RunStreamEvent = RunEvent | TokenEvent;

/** The body of `POST /api/approvals/{id}`. */
export interface ApprovalDecision {
  /** Tool approvals: approve, reject, or approve with edited arguments. */
  decision?: "approve" | "reject" | "edit";
  /** Human forms: the submitted field values. */
  values?: Record<string, unknown>;
  edited_args?: Record<string, unknown>;
  message?: string;
}

export interface RequestOptions {
  /** Overrides the client's token for this call. */
  token?: string;
  signal?: AbortSignal;
}

// ── Typed workflows (`npx tuvl-client generate`) ─────────────────────────────

/** One workflow's contract: its input and the bodies of its ends by status. */
export interface WorkflowContract {
  input: Record<string, unknown>;
  /** The body of the default end. */
  output: unknown;
  /** The body of every end, by HTTP status. */
  ends?: Record<number, unknown>;
}

/** Workflow name → contract. Generated from `/openapi.json`; untyped by default. */
export type WorkflowTypes = Record<string, WorkflowContract>;

export interface TuvlClientOptions {
  /** Base URL of the tuvl server, e.g. `http://localhost:8885`. */
  baseUrl: string;
  /** Access token (JWT) sent with every request (see `setToken`). */
  token?: string;
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** A request the server refused (auth, unknown workflow or run, bad input). */
export class TuvlApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
    readonly path: string,
  ) {
    super(`tuvl ${path} → HTTP ${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    this.name = "TuvlApiError";
  }
}

/** A run that ended at an error end (status ≥ 400), failed, or was aborted. */
export class TuvlRunError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly runId: string | null,
  ) {
    super(`tuvl run ${runId ?? "?"} ended with HTTP ${status}: ${JSON.stringify(body)}`);
    this.name = "TuvlRunError";
  }
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
