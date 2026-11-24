/**
 * The tuvl 2.x client (spec §15): start workflow runs, follow them, operate
 * them and decide approvals — REST + SSE only.
 */

import { CrudClient } from "./crud";
import { followRun } from "./follow";
import { RolesClient } from "./roles";
import { toFormData } from "./form";
import { MAX_TRANSIENT, jitter, pause, sleep, transient } from "./retry";
import { Transport, jsonBody, refusal } from "./transport";
import {
  TERMINAL_STATUSES,
  isTokenEvent,
  TuvlApiError,
  TuvlRunError,
  TuvlTimeoutError,
  WAITING_STATUSES,
  type Approval,
  type ApprovalDecision,
  type RequestOptions,
  type Run,
  type RunEvent,
  type RunStatus,
  type RunStreamEvent,
  type TokenDelta,
  type TokenEvent,
  type TuvlClientOptions,
  type WebhookDelivery,
  type WorkflowTypes,
} from "./types";

type Input<W extends WorkflowTypes, K extends keyof W> = W[K]["input"];
type Output<W extends WorkflowTypes, K extends keyof W> = W[K]["output"];

/**
 * A run that is still going (or waiting on a person) when the call returns.
 * `wait()` resolves its output; `events()` follows its journal.
 */
export class RunHandle<TOutput = unknown> {
  constructor(
    private readonly client: TuvlClient<WorkflowTypes>,
    readonly id: string,
    /** The run as last seen. */
    public run: Run | null = null,
  ) {}

  /** Refresh and return the run. */
  async get(options?: RequestOptions): Promise<Run> {
    try {
      this.run = await this.client.runs.get(this.id, options);
    } catch (error) {
      throw this.explained(error);
    }
    return this.run;
  }

  /**
   * A run started by an anonymous caller of a public trigger has no `status_url` and nobody can read it but
   * `iam:admin`; the server says only "Not authenticated". Say why.
   */
  private explained(error: unknown): unknown {
    if (!(error instanceof TuvlApiError) || ![401, 403, 404].includes(error.status)) return error;
    if (!this.run || this.run.status_url !== undefined) return error;
    const said = typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail);
    return new TuvlApiError(
      error.status,
      `${said} (this run was started by an anonymous caller of a public trigger, which only a token with iam:admin can read or follow)`,
      error.path,
    );
  }

  /**
   * The run's events: replay from `fromSeq`, then live until it ends (unless `follow: false`). A followed stream
   * whose connection drops is reopened from the last position read, without repeating or skipping an event; when it
   * cannot be reopened the iterator throws {@link TuvlStreamError}. `follow: false` is one pass and never reconnects.
   * Journal positions (`seq`) have gaps: resume from the last one seen plus one, never from a count.
   */
  async *events(options?: RequestOptions & { fromSeq?: number; follow?: boolean }): AsyncGenerator<RunEvent> {
    try {
      yield* this.client.runs.events(this.id, options);
    } catch (error) {
      throw this.explained(error);
    }
  }

  /** The run's journal events and the live draft of an answer being written, in order. */
  async *stream(options?: RequestOptions & { fromSeq?: number; follow?: boolean }): AsyncGenerator<RunStreamEvent> {
    try {
      yield* this.client.runs.stream(this.id, options);
    } catch (error) {
      throw this.explained(error);
    }
  }

  /**
   * The text of answers as the model writes it (`stream_tokens: true` on an `llm` agent): `token_delta`
   * pieces to append and `token_reset` to throw the draft away. A client that joins mid-agent first gets the
   * draft so far as one piece with `replay: true`. Ends when the run does.
   */
  async *tokens(options?: RequestOptions & { agentId?: string }): AsyncGenerator<TokenEvent> {
    try {
      yield* this.client.runs.tokens(this.id, options);
    } catch (error) {
      throw this.explained(error);
    }
  }

  /**
   * Call `listener` with each piece of an answer as it is written, until the run ends or `stop()` is called.
   * `onReset` is called when the draft must be discarded. Resolve `done` to know the stream has ended
   * (it rejects if the stream fails).
   *
   * ```ts
   * const live = handle.onToken((delta) => (box.textContent += delta), { onReset: () => (box.textContent = "") });
   * const result = await handle.wait();
   * await live.done;
   * ```
   */
  onToken(
    listener: (delta: string, event: TokenDelta) => void,
    options: RequestOptions & { agentId?: string; onReset?: (agentId: string) => void } = {},
  ): { stop: () => void; done: Promise<void> } {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (async () => {
      try {
        for await (const event of this.tokens({ ...options, signal: controller.signal })) {
          if (event.type === "token_delta") listener(event.delta, event);
          else options.onReset?.(event.agent_id);
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
      }
    })();
    done.catch(() => {}); // a caller that never awaits `done` gets no unhandled rejection; one that does still sees it fail
    return { stop: () => controller.abort(), done };
  }

  /**
   * Poll until the run ends and return its output. Rejects with {@link TuvlRunError} for an error end, a failure or an
   * abort. With `untilWaiting`, also resolves (to `undefined`) when the run waits on a person, an approval or an operator.
   *
   * The poll slows down while nothing changes: from `intervalMs` (default 500) by half again each time, up to
   * `maxIntervalMs` (default 5000; set it to `intervalMs` for a fixed interval). A dropped connection or a 5xx or `429`
   * (its `Retry-After` is honoured) is retried, up to five times in a row; any other refusal rejects at once. With
   * `timeoutMs` it rejects with {@link TuvlTimeoutError} once that time has passed.
   *
   * A run that waits on a person stays `waiting_human` until someone answers, so without `untilWaiting`, `timeoutMs`
   * or a `signal` this polls for as long as they take.
   */
  async wait(
    options?: RequestOptions & { intervalMs?: number; maxIntervalMs?: number; timeoutMs?: number; untilWaiting?: boolean },
  ): Promise<TOutput | undefined> {
    const base = options?.intervalMs ?? 500;
    const cap = Math.max(base, options?.maxIntervalMs ?? 5_000);
    const deadline = options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : Infinity;
    let delay = base;
    let seen: string | undefined;
    let failures = 0;
    for (;;) {
      let wait: number;
      try {
        const run = await this.get(options);
        failures = 0;
        if (TERMINAL_STATUSES.includes(run.status)) return outputOf<TOutput>(run);
        if (options?.untilWaiting && WAITING_STATUSES.includes(run.status)) return undefined;
        const now = `${run.status}/${run.current_agent}`;
        delay = now === seen ? Math.min(cap, delay * 1.5) : base;
        seen = now;
        wait = Math.min(cap, jitter(delay));
      } catch (error) {
        failures += 1;
        if (!transient(error) || failures > MAX_TRANSIENT) throw error;
        wait = pause(failures, error, base, Math.max(cap, 8_000));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TuvlTimeoutError(this.id, this.run?.status, options?.timeoutMs ?? 0);
      await sleep(Math.min(wait, remaining), options?.signal);
    }
  }

  pause(options?: RequestOptions): Promise<Run> {
    return this.client.runs.control(this.id, "pause", undefined, options);
  }

  resume(options?: RequestOptions): Promise<Run> {
    return this.client.runs.control(this.id, "resume", undefined, options);
  }

  abort(options?: RequestOptions): Promise<Run> {
    return this.client.runs.control(this.id, "abort", undefined, options);
  }

  /** Send guidance to a running loop agent. */
  steer(message: string, options?: RequestOptions): Promise<Run> {
    return this.client.runs.control(this.id, "steer", message, options);
  }
}

function outputOf<T>(run: Run): T {
  const status = run.output?.status ?? (run.status === "completed" ? 200 : 500);
  if (run.status === "completed" || run.status === "compensated") {
    if (status >= 400 || run.status === "compensated") {
      throw new TuvlRunError(status, run.output?.body ?? run.error, run.run_id);
    }
    return run.output?.body as T;
  }
  throw new TuvlRunError(status, run.error, run.run_id);
}

/**
 * @example
 * ```ts
 * const client = new TuvlClient({ baseUrl: "http://localhost:8885", token });
 * const result = await client.execute("triage_ticket", { subject, body, customer_email });
 * if (result instanceof RunHandle) await result.wait({ untilWaiting: true });   // waits on a person
 * ```
 *
 * Pass the generated `Workflows` type (`npx tuvl-client generate`) for typed
 * inputs and outputs: `new TuvlClient<Workflows>({ ... })`.
 */
export class TuvlClient<W extends WorkflowTypes = WorkflowTypes> {
  readonly transport: Transport;

  constructor(options: TuvlClientOptions) {
    this.transport = new Transport({ baseUrl: options.baseUrl, defaultToken: options.token });
  }

  setToken(token: string): void {
    this.transport.setToken(token);
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  /**
   * Start `workflow` and wait up to its `sync_timeout`. Resolves the end's
   * body; resolves a {@link RunHandle} when the run outlives the window or
   * waits on a person or approval. Rejects with {@link TuvlRunError} for an
   * error end (status ≥ 400) and {@link TuvlApiError} when the server refuses.
   */
  async execute<K extends keyof W & string>(
    workflow: K,
    input: Input<W, K>,
    options?: RequestOptions,
  ): Promise<Output<W, K> | RunHandle<Output<W, K>>> {
    return this.startRun<Output<W, K>>(workflow, input, true, options);
  }

  /** Start `workflow` without waiting; returns its handle. */
  async start<K extends keyof W & string>(
    workflow: K,
    input: Input<W, K>,
    options?: RequestOptions,
  ): Promise<RunHandle<Output<W, K>>> {
    const result = await this.startRun<Output<W, K>>(workflow, input, false, options);
    if (result instanceof RunHandle) return result;
    throw new Error("tuvl: the server finished a run started without waiting"); // never: wait=false answers 202
  }

  private async startRun<T>(
    workflow: string,
    input: unknown,
    wait: boolean,
    options?: RequestOptions,
  ): Promise<T | RunHandle<T>> {
    const path = `/api/workflows/${encodeURIComponent(workflow)}/runs`;
    const form = toFormData(input);
    const response = await this.transport.request("POST", path, {
      ...(form ? { form } : { body: { input } }),
      query: { wait },
      ...options,
    });
    const runId = response.headers.get("x-tuvl-run-id");
    if (response.status === 202) {
      const run = (await jsonBody(response, path)) as Run;
      return new RunHandle<T>(this as unknown as TuvlClient<WorkflowTypes>, run.run_id, run);
    }
    if (runId === null) throw await refusal(response, path);
    const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) throw new TuvlRunError(response.status, body, runId);
    return body as T;
  }

  /**
   * Whether the server can serve requests now (`GET /ready`): `true` for a `200`, `false` for the `503` of a server that is
   * starting, shutting down or cannot reach its database. Anything else, or no answer, rejects. For scripts and tests that
   * wait for a server; the answer says nothing about the caller's token.
   */
  async ready(options?: RequestOptions): Promise<boolean> {
    const response = await this.transport.request("GET", "/ready", options);
    if (response.status === 200) return true;
    if (response.status === 503) return false;
    throw await refusal(response, "/ready");
  }

  /** A handle on an existing run. */
  run<T = unknown>(runId: string): RunHandle<T> {
    return new RunHandle<T>(this as unknown as TuvlClient<WorkflowTypes>, runId);
  }

  readonly runs = {
    list: (
      filters: { workflow?: string; status?: RunStatus; limit?: number } = {},
      options?: RequestOptions,
    ): Promise<Run[]> =>
      this.transport.json<Run[]>("GET", "/api/runs", { query: { ...filters }, ...options }),

    get: (runId: string, options?: RequestOptions): Promise<Run> =>
      this.transport.json<Run>("GET", `/api/runs/${encodeURIComponent(runId)}`, options),

    /** Replay from `fromSeq`, then follow live until the run ends (unless `follow: false`). */
    events: (runId: string, options?: RequestOptions & { fromSeq?: number; follow?: boolean }): AsyncGenerator<RunEvent> =>
      this.followEvents(runId, options),

    /** Journal events plus the live draft of answers being written (`token_delta`, `token_reset`). */
    stream: (runId: string, options?: RequestOptions & { fromSeq?: number; follow?: boolean }): AsyncGenerator<RunStreamEvent> =>
      this.followStream(runId, options),

    /** Only the live drafts. `agentId` keeps one agent's. */
    tokens: (runId: string, options?: RequestOptions & { agentId?: string }): AsyncGenerator<TokenEvent> =>
      this.followTokens(runId, options),

    control: (
      runId: string,
      action: "pause" | "resume" | "abort" | "steer",
      message?: string,
      options?: RequestOptions,
    ): Promise<Run> =>
      this.transport.json<Run>("POST", `/api/runs/${encodeURIComponent(runId)}/${action}`, {
        body: message !== undefined ? { message } : {},
        ...options,
      }),

    /** The webhook notifications of a run and whether each was delivered. */
    webhooks: (runId: string, options?: RequestOptions): Promise<WebhookDelivery[]> =>
      this.transport.json<WebhookDelivery[]>("GET", `/api/runs/${encodeURIComponent(runId)}/webhooks`, options),

    /** Send one notification again (scope `runs:control`). */
    redeliverWebhook: (runId: string, deliveryId: string, options?: RequestOptions): Promise<{ id: string; status: string }> =>
      this.transport.json("POST", `/api/runs/${encodeURIComponent(runId)}/webhooks/${encodeURIComponent(deliveryId)}/redeliver`, options),

    /** The run's journal as a replayable fixture (`tuvl pin run`). */
    export: (runId: string, options?: RequestOptions): Promise<Record<string, unknown>> =>
      this.transport.json("GET", `/api/runs/${encodeURIComponent(runId)}/export`, options),
  };

  readonly approvals = {
    /** Pending approvals the caller may decide. */
    list: (options?: RequestOptions): Promise<Approval[]> => this.transport.json<Approval[]>("GET", "/api/approvals", options),

    decide: (approvalId: string, decision: ApprovalDecision, options?: RequestOptions): Promise<Record<string, unknown>> =>
      this.transport.json("POST", `/api/approvals/${encodeURIComponent(approvalId)}`, { body: decision, ...options }),
  };

  /**
   * Role membership: list roles, find users, add or remove a member, disable or enable a role.
   * Needs a server that mounts the `roles` API group (tuvl >= 2.1.0, `roles` in `spec.api.expose`)
   * and a token with `roles:manage`. See {@link RolesClient}.
   */
  roles(): RolesClient {
    return new RolesClient(this.transport);
  }

  /** CRUD on a model exposed with `spec.api.crud`. */
  crud<TRead = unknown, TCreate = Partial<TRead>, TUpdate = Partial<TRead>>(
    model: string,
  ): CrudClient<TRead, TCreate, TUpdate> {
    return new CrudClient<TRead, TCreate, TUpdate>(this.transport, model);
  }

  private async eventsResponse(
    runId: string,
    options: (RequestOptions & { fromSeq?: number; follow?: boolean }) | undefined,
    drafts: boolean,
  ): Promise<Response> {
    const path = `/api/runs/${encodeURIComponent(runId)}/events`;
    const response = await this.transport.request("GET", path, {
      accept: "text/event-stream",
      query: { from_seq: options?.fromSeq, follow: options?.follow, drafts: drafts || undefined },
      token: options?.token,
      signal: options?.signal,
    });
    if (!response.ok) throw await refusal(response, path);
    return response;
  }

  private follow(
    runId: string,
    options: (RequestOptions & { fromSeq?: number; follow?: boolean }) | undefined,
    drafts: boolean,
  ): AsyncGenerator<RunStreamEvent> {
    return followRun(
      runId,
      {
        open: (fromSeq, replayOnly) =>
          this.eventsResponse(runId, { ...options, fromSeq, follow: replayOnly ? false : options?.follow }, drafts),
        status: () => this.runs.get(runId, { token: options?.token, signal: options?.signal }),
      },
      options,
    );
  }

  private async *followEvents(
    runId: string,
    options?: RequestOptions & { fromSeq?: number; follow?: boolean },
  ): AsyncGenerator<RunEvent> {
    for await (const event of this.follow(runId, options, false)) if (!isTokenEvent(event)) yield event;
  }

  private followStream(
    runId: string,
    options?: RequestOptions & { fromSeq?: number; follow?: boolean },
  ): AsyncGenerator<RunStreamEvent> {
    return this.follow(runId, options, true);
  }

  private async *followTokens(
    runId: string,
    options?: RequestOptions & { agentId?: string },
  ): AsyncGenerator<TokenEvent> {
    for await (const event of this.follow(runId, { ...options, fromSeq: undefined }, true)) {
      if (isTokenEvent(event) && (!options?.agentId || event.agent_id === options.agentId)) yield event;
    }
  }
}

