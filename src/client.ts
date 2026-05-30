/**
 * TuvlClient — the main entry point for @tuvl/client.
 *
 * Auto-detects the best transport for each workflow call:
 *
 *   mode="rest"  (default)    → plain POST, unwraps the REST envelope
 *   mode="sse"  (auto)        → SSE streaming when onProgress is provided
 *                               AND the workflow has_slow_steps === true
 *   mode="grpc"               → gRPC-Web via sonora (requires peer deps)
 *
 * Return-value contract — IDENTICAL across all three transports:
 *
 *   • on success                  → resolves with the `data` value
 *   • on workflow-business error  → rejects with `TuvlWorkflowError`
 *   • on HITL suspension          → rejects with `TuvlWorkflowSuspendedError`
 *   • on transport / engine error → rejects with a plain `Error`
 *
 * Manifest caching avoids extra round-trips on repeated calls to the same
 * workflow.  TTL defaults to 60 s and is configurable.
 */

import { parseSseStream } from "./sse";
import { Transport } from "./transport";
import {
  TuvlWorkflowError,
  TuvlWorkflowSuspendedError,
  type DoneEvent,
  type ErrorEvent,
  type ExecuteOptions,
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

  /** Expose the base URL for callers that need raw access (e.g. gRPC). */
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
   * 1. mode="grpc"            → gRPC-Web (always, regardless of onProgress)
   * 2. mode="sse"             → SSE stream
   * 3. onProgress provided    → SSE if workflow has_slow_steps, else REST
   * 4. default                → REST
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
      (mode !== "rest" && mode !== "grpc" && !!onProgress && manifest.has_slow_steps);

    if (mode === "grpc") {
      return this._executeGrpc<TOutput>(manifest, payload, onProgress, onSuspended, token, signal);
    }

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

  // ── gRPC-Web transport ────────────────────────────────────────────────────

  private async _executeGrpc<TOutput>(
    manifest: WorkflowManifest,
    payload: Record<string, unknown>,
    onProgress: ((event: StepEvent) => void) | undefined,
    onSuspended: ((event: SuspendedEvent) => void) | undefined,
    token: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TOutput> {
    const { openGrpcStream } = await import("./grpc");

    let finalSnapshot: Record<string, unknown> | undefined;

    for await (const event of openGrpcStream({
      baseUrl: this.baseUrl,
      workflowName: manifest.name,
      payloadJson: JSON.stringify(payload),
      token,
      signal,
    })) {
      switch (event.event_type) {
        case "step":
          onProgress?.(event as StepEvent);
          break;
        case "done":
          // gRPC servicer emits the last-step snapshot as `snapshot_json`.
          // It is NOT pre-wrapped in {success, data, error} like SSE.
          finalSnapshot = (event as unknown as { snapshot: Record<string, unknown> }).snapshot;
          break;
        case "suspended": {
          // The gRPC servicer stuffs the HITL payload into snapshot_json.
          const snap = (event as unknown as { snapshot: Record<string, unknown> }).snapshot;
          const suspended: SuspendedEvent = {
            event_type: "suspended",
            paused_step_id: (event as unknown as { step_id?: string }).step_id,
            ...snap,
          };
          onSuspended?.(suspended);
          throw new TuvlWorkflowSuspendedError(suspended);
        }
        case "error":
          throw new Error(
            `tuvl workflow '${manifest.name}' gRPC error: ${event.error_detail ?? "unknown"}`,
          );
      }
    }

    if (finalSnapshot === undefined) {
      throw new Error(`tuvl gRPC stream for '${manifest.name}' ended without a done event`);
    }

    // gRPC mirrors the REST workflow contract via the workflow snapshot:
    // a `_last_error` key in context signals a business failure.
    if ("_last_error" in finalSnapshot) {
      throw new TuvlWorkflowError(
        `tuvl workflow '${manifest.name}' failed`,
        finalSnapshot,
        (finalSnapshot._last_error as never) ?? null,
      );
    }

    // Prefer the `_response` key when the workflow set one; else return the
    // full public snapshot.  This mirrors the REST envelope's `data` semantics.
    if ("_response" in finalSnapshot) {
      return finalSnapshot._response as TOutput;
    }
    return finalSnapshot as TOutput;
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
}
