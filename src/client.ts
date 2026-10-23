/**
 * The tuvl 2.0 client (spec §15): start workflow runs, follow them, operate
 * them and decide approvals — REST + SSE only.
 */

import { CrudClient } from "./crud";
import { toFormData } from "./form";
import { parseSseStream } from "./sse";
import { Transport } from "./transport";
import {
  TERMINAL_STATUSES,
  TuvlApiError,
  TuvlRunError,
  WAITING_STATUSES,
  type Approval,
  type ApprovalDecision,
  type RequestOptions,
  type Run,
  type RunEvent,
  type RunStatus,
  type TuvlClientOptions,
  type WebhookDelivery,
  type WorkflowTypes,
} from "./types";

type Input<W extends WorkflowTypes, K extends keyof W> = W[K]["input"];
type Output<W extends WorkflowTypes, K extends keyof W> = W[K]["output"];

async function detail(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && "detail" in parsed
      ? (parsed as { detail: unknown }).detail
      : parsed;
  } catch {
    return text;
  }
}

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
    this.run = await this.client.runs.get(this.id, options);
    return this.run;
  }

  /** The run's events: replay from `fromSeq`, then live until it ends (unless `follow: false`). */
  events(options?: RequestOptions & { fromSeq?: number; follow?: boolean }): AsyncGenerator<RunEvent> {
    return this.client.runs.events(this.id, options);
  }

  /**
   * Poll until the run ends and return its output. Rejects with
   * {@link TuvlRunError} for an error end, a failure or an abort. With
   * `untilWaiting`, also resolves (to `undefined`) when the run waits on a
   * person, an approval or an operator.
   */
  async wait(
    options?: RequestOptions & { intervalMs?: number; timeoutMs?: number; untilWaiting?: boolean },
  ): Promise<TOutput | undefined> {
    const interval = options?.intervalMs ?? 500;
    const deadline = options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : Infinity;
    for (;;) {
      const run = await this.get(options);
      if (TERMINAL_STATUSES.includes(run.status)) return outputOf<TOutput>(run);
      if (options?.untilWaiting && WAITING_STATUSES.includes(run.status)) return undefined;
      if (Date.now() + interval > deadline) {
        throw new Error(`tuvl run ${this.id} is still ${run.status} after ${options?.timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
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
 * if (result instanceof RunHandle) await result.wait();   // waited on a person
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
      const run = (await response.json()) as Run;
      return new RunHandle<T>(this as unknown as TuvlClient<WorkflowTypes>, run.run_id, run);
    }
    if (runId === null) throw new TuvlApiError(response.status, await detail(response), path);
    const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) throw new TuvlRunError(response.status, body, runId);
    return body as T;
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
      this.json<Run[]>("GET", "/api/runs", { query: { ...filters }, ...options }),

    get: (runId: string, options?: RequestOptions): Promise<Run> =>
      this.json<Run>("GET", `/api/runs/${encodeURIComponent(runId)}`, options),

    /** Replay from `fromSeq`, then follow live until the run ends (unless `follow: false`). */
    events: (runId: string, options?: RequestOptions & { fromSeq?: number; follow?: boolean }): AsyncGenerator<RunEvent> =>
      this.followEvents(runId, options),

    control: (
      runId: string,
      action: "pause" | "resume" | "abort" | "steer",
      message?: string,
      options?: RequestOptions,
    ): Promise<Run> =>
      this.json<Run>("POST", `/api/runs/${encodeURIComponent(runId)}/${action}`, {
        body: message !== undefined ? { message } : {},
        ...options,
      }),

    /** The webhook notifications of a run and whether each was delivered. */
    webhooks: (runId: string, options?: RequestOptions): Promise<WebhookDelivery[]> =>
      this.json<WebhookDelivery[]>("GET", `/api/runs/${encodeURIComponent(runId)}/webhooks`, options),

    /** Send one notification again (scope `runs:control`). */
    redeliverWebhook: (runId: string, deliveryId: string, options?: RequestOptions): Promise<{ id: string; status: string }> =>
      this.json("POST", `/api/runs/${encodeURIComponent(runId)}/webhooks/${encodeURIComponent(deliveryId)}/redeliver`, options),

    /** The run's journal as a replayable fixture (`tuvl pin run`). */
    export: (runId: string, options?: RequestOptions): Promise<Record<string, unknown>> =>
      this.json("GET", `/api/runs/${encodeURIComponent(runId)}/export`, options),
  };

  readonly approvals = {
    /** Pending approvals the caller may decide. */
    list: (options?: RequestOptions): Promise<Approval[]> => this.json<Approval[]>("GET", "/api/approvals", options),

    decide: (approvalId: string, decision: ApprovalDecision, options?: RequestOptions): Promise<Record<string, unknown>> =>
      this.json("POST", `/api/approvals/${encodeURIComponent(approvalId)}`, { body: decision, ...options }),
  };

  /** CRUD on a model exposed with `spec.api.crud`. */
  crud<TRead = unknown, TCreate = Partial<TRead>, TUpdate = Partial<TRead>>(
    model: string,
  ): CrudClient<TRead, TCreate, TUpdate> {
    return new CrudClient<TRead, TCreate, TUpdate>(this.transport, model);
  }

  private async json<T>(
    method: string,
    path: string,
    options?: RequestOptions & { body?: unknown; query?: Record<string, string | number | boolean | undefined> },
  ): Promise<T> {
    const response = await this.transport.request(method, path, options);
    if (!response.ok) throw new TuvlApiError(response.status, await detail(response), path);
    return (await response.json()) as T;
  }

  private async *followEvents(
    runId: string,
    options?: RequestOptions & { fromSeq?: number; follow?: boolean },
  ): AsyncGenerator<RunEvent> {
    const path = `/api/runs/${encodeURIComponent(runId)}/events`;
    const response = await this.transport.request("GET", path, {
      accept: "text/event-stream",
      query: { from_seq: options?.fromSeq, follow: options?.follow },
      token: options?.token,
      signal: options?.signal,
    });
    if (!response.ok) throw new TuvlApiError(response.status, await detail(response), path);
    yield* parseSseStream(response, options?.signal);
  }

}

