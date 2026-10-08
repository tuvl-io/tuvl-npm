/**
 * TuvlClient — the main entry point for @tuvl/client.
 *
 * Auto-detects the best transport for each workflow call:
 *
 *   mode="rest"  (default)    → plain POST, unwraps the REST envelope
 *   mode="sse"  (auto)        → SSE streaming when onProgress is provided
 *                               AND the workflow has_slow_steps === true
 *
 * Return-value contract — IDENTICAL across both transports:
 *
 *   • on success                  → resolves with the `data` value
 *   • on workflow-business error  → rejects with `TuvlWorkflowError`
 *   • on HITL suspension          → rejects with `TuvlWorkflowSuspendedError`
 *   • on transport / engine error → rejects with a plain `Error`
 *
 * Manifest caching avoids extra round-trips on repeated calls to the same
 * workflow.  TTL defaults to 60 s and is configurable.
 */

import { CrudClient } from "./crud";
import { parseSseStream } from "./sse";
import { Transport } from "./transport";
import {
  TuvlWorkflowError,
  TuvlWorkflowSuspendedError,
  type DoneEvent,
  type ErrorEvent,
  type ExecuteOptions,
  type ExecuteVersionedOptions,
  type ResumeOptions,
  type ResumeRequest,
  type RestEnvelope,
  type StepEvent,
  type SuspendedEvent,
  type TuvlClientOptions,
  type WorkflowManifest,
  type WorkflowManifestMap,
} from "./types";

interface CacheEntry {
  manifest: WorkflowManifest;
  expiresAt: number;
}

export class TuvlClient {
  private readonly transport: Transport;
  private readonly manifestCache = new Map<string, CacheEntry>();
  private readonly manifestCacheTtl: number;

  constructor(options: TuvlClientOptions) {
    this.transport = new Transport({
      baseUrl: options.baseUrl,
      defaultToken: options.token,
    });
    this.manifestCacheTtl = options.manifestCacheTtl ?? 60_000;
  }

  /** Update the default auth token (e.g. after token refresh). */
  setToken(token: string): void {
    this.transport.setToken(token);
  }

  /** Expose the base URL for callers that need raw access. */
  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  // ── Manifest ──────────────────────────────────────────────────────────────

  /** Fetch (and cache) the manifest for a single workflow. */
  async getManifest(
    workflowName: string,
    options?: { token?: string; signal?: AbortSignal },
  ): Promise<WorkflowManifest> {
    const cached = this.manifestCache.get(workflowName);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.manifest;
    }

    const manifest = await this.transport.get<WorkflowManifest>(
      `/api/_system/workflows/${encodeURIComponent(workflowName)}`,
      options,
    );

    if (this.manifestCacheTtl > 0) {
      this.manifestCache.set(workflowName, {
        manifest,
        expiresAt: Date.now() + this.manifestCacheTtl,
      });
    }

    return manifest;
  }

  /** Fetch manifests for all registered workflows. */
  async listWorkflows(
    options?: { token?: string; signal?: AbortSignal },
  ): Promise<WorkflowManifestMap> {
    return this.transport.get<WorkflowManifestMap>("/api/_system/workflows", options);
  }

  /** Invalidate the cached manifest for a workflow (or all if no name given). */
  invalidateManifest(workflowName?: string): void {
    if (workflowName) {
      this.manifestCache.delete(workflowName);
    } else {
      this.manifestCache.clear();
    }
  }

  // ── Execute ───────────────────────────────────────────────────────────────

  /**
   * Execute a workflow and return its `data` payload.
   *
   * Transport selection:
   * 1. mode="sse"             → SSE stream
   * 2. onProgress provided    → SSE if workflow has_slow_steps, else REST
   * 3. default                → REST
   *
   * @throws {TuvlWorkflowError}          when the workflow returns success=false
   * @throws {TuvlWorkflowSuspendedError} when the workflow suspends at HITL
   * @throws {Error}                      on transport / engine failures
   */
  async execute<TOutput = unknown>(
    workflowName: string,
    options: ExecuteOptions<TOutput> = {},
  ): Promise<TOutput> {
    const { payload = {}, onProgress, onSuspended, mode, token, signal } = options;

    // Fetch manifest to resolve trigger_path and streaming hints
    const manifest = await this.getManifest(workflowName, { token, signal });

    const useSse =
      mode === "sse" ||
      (mode !== "rest" && !!onProgress && manifest.has_slow_steps);

    if (useSse) {
      return this._executeSse<TOutput>(manifest, payload, onProgress, onSuspended, token, signal);
    }

    // Plain REST — server returns RestEnvelope; unwrap it.
    const envelope = await this.transport.post<Record<string, unknown>, RestEnvelope<TOutput>>(
      manifest.trigger_path,
      payload,
      { token, signal },
    );
    return this._unwrapRest<TOutput>(envelope, manifest.name);
  }

  /**
   * Execute a specific version of a workflow via `/{version}/run/{name}`.
   *
   * Useful when you want to pin to a particular schema_version without
   * relying on the currently-active default trigger path.
   *
   * @throws {TuvlWorkflowError}          when the workflow returns success=false
   * @throws {TuvlWorkflowSuspendedError} when the workflow suspends at HITL
   * @throws {Error}                      on transport / engine failures
   */
  async executeVersioned<TOutput = unknown>(
    workflowName: string,
    version: string,
    options: ExecuteVersionedOptions<TOutput> | ExecuteOptions<TOutput> = {},
  ): Promise<TOutput> {
    const { payload = {}, onProgress, onSuspended, mode, token, signal } = options;
    const triggerPath = `/${version}/run/${workflowName}`;

    // Best-effort: fetch manifest to determine has_slow_steps for SSE auto-upgrade.
    let cachedManifest: WorkflowManifest | undefined;
    try {
      cachedManifest = await this.getManifest(workflowName, { token, signal });
    } catch {
      // If manifest fetch fails, fall back to the caller's explicit mode.
    }

    const syntheticManifest: WorkflowManifest = {
      name: workflowName,
      trigger_path: triggerPath,
      trigger_method: "POST",
      has_slow_steps: cachedManifest?.has_slow_steps ?? false,
      slow_kinds_present: cachedManifest?.slow_kinds_present ?? [],
      steps: cachedManifest?.steps ?? [],
    };

    const useSse =
      mode === "sse" ||
      (mode !== "rest" && !!onProgress && syntheticManifest.has_slow_steps);

    if (useSse) {
      return this._executeSse<TOutput>(
        syntheticManifest,
        payload,
        onProgress,
        onSuspended,
        token,
        signal,
      );
    }

    const envelope = await this.transport.post<Record<string, unknown>, RestEnvelope<TOutput>>(
      triggerPath,
      payload,
      { token, signal },
    );
    return this._unwrapRest<TOutput>(envelope, workflowName);
  }

  /**
   * Resume a HITL-suspended workflow instance.
   *
   * After the workflow throws `TuvlWorkflowSuspendedError`, capture the
   * `event.instance_id` from the suspended event and pass it here along with
   * the human-provided data to continue execution.
   *
   * @throws {TuvlWorkflowError}          when the resumed workflow returns success=false
   * @throws {TuvlWorkflowSuspendedError} when the workflow suspends again at another HITL step
   * @throws {Error}                      on transport / engine failures
   */
  async resumeWorkflow<TOutput = unknown>(
    options: ResumeOptions<TOutput>,
  ): Promise<TOutput> {
    const { instanceId, humanInput = {}, onProgress, onSuspended, mode, token, signal } = options;

    const body: ResumeRequest = {
      instance_id: instanceId,
      human_input: humanInput,
    };

    if (mode === "sse" || (mode !== "rest" && !!onProgress)) {
      // Wrap in a synthetic manifest so we can reuse _executeSse.
      // The server's resume SSE path mirrors the trigger SSE path.
      const syntheticManifest: WorkflowManifest = {
        name: `(resumed:${instanceId})`,
        trigger_path: "/api/workflows/resume",
        trigger_method: "POST",
        has_slow_steps: true,
        slow_kinds_present: [],
        steps: [],
      };
      return this._executeSse<TOutput>(
        syntheticManifest,
        body as unknown as Record<string, unknown>,
        onProgress,
        onSuspended,
        token,
        signal,
      );
    }

    // Plain REST resume — returns RestEnvelope<TOutput>.
    const envelope = await this.transport.post<ResumeRequest, RestEnvelope<TOutput>>(
      "/api/workflows/resume",
      body,
      { token, signal },
    );
    return this._unwrapRest<TOutput>(envelope, `(resumed:${instanceId})`);
  }

  // ── SSE transport ─────────────────────────────────────────────────────────

  private async _executeSse<TOutput>(
    manifest: WorkflowManifest,
    payload: Record<string, unknown>,
    onProgress: ((event: StepEvent) => void) | undefined,
    onSuspended: ((event: SuspendedEvent) => void) | undefined,
    token: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TOutput> {
    const response = await this.transport.postStream(manifest.trigger_path, payload, {
      token,
      signal,
    });

    let done: DoneEvent | undefined;

    for await (const frame of parseSseStream(response, signal)) {
      switch (frame.event_type) {
        case "step":
          onProgress?.(frame);
          break;
        case "done":
          done = frame;
          break;
        case "suspended":
          onSuspended?.(frame);
          throw new TuvlWorkflowSuspendedError(frame);
        case "error": {
          const err = frame as ErrorEvent;
          throw new Error(
            `tuvl workflow '${manifest.name}' engine error: ${err.message}` +
              (err.details ? ` — ${err.details}` : ""),
          );
        }
      }
    }

    if (!done) {
      throw new Error(`tuvl SSE stream for '${manifest.name}' ended without a done event`);
    }

    if (!done.success) {
      throw new TuvlWorkflowError(
        `tuvl workflow '${manifest.name}' failed`,
        done.data,
        done.error,
      );
    }

    return done.data as TOutput;
  }

  // ── REST envelope ─────────────────────────────────────────────────────────

  private _unwrapRest<TOutput>(envelope: RestEnvelope<TOutput>, workflowName: string): TOutput {
    if (!envelope || typeof envelope !== "object") {
      // Server returned a bare body (older endpoint, or HITL 202 etc.) —
      // hand it back verbatim.
      return envelope as unknown as TOutput;
    }

    if (envelope.success === false) {
      throw new TuvlWorkflowError(
        `tuvl workflow '${workflowName}' failed`,
        envelope.data,
        envelope.error,
      );
    }

    // success===true OR envelope-shape mismatch (no `success` key) → return data
    // when present, else the whole body.
    return (envelope.data ?? (envelope as unknown)) as TOutput;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Return a typed CRUD client for a tuvl model endpoint.
   *
   * The returned client targets `/models/{modelName}/` and shares the
   * same transport (base URL + auth token) as this TuvlClient instance.
   *
   * @example
   * ```ts
   * // List all candidates
   * const all = await client.crud("candidate").list();
   *
   * // With filters + embedded relations
   * const results = await client.crud("candidate").list({
   *   filters: { stage: "screening" },
   *   include: ["posting"],
   *   limit: 50,
   * });
   *
   * // Get one record
   * const c = await client.crud("candidate").get("uuid-here");
   *
   * // Strongly-typed variant
   * const c2 = await client
   *   .crud<CandidateRead, CandidateCreate>("candidate")
   *   .create({ name: "Alice", email: "alice@example.com" });
   * ```
   */
  crud<TRead = unknown, TCreate = Partial<TRead>, TUpdate = Partial<TRead>>(
    modelName: string,
  ): CrudClient<TRead, TCreate, TUpdate> {
    return new CrudClient<TRead, TCreate, TUpdate>(this.transport, modelName);
  }
}
