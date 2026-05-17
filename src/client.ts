/**
 * TuvlClient — the main entry point for @tuvl/client.
 *
 * Auto-detects the best transport for each workflow call:
 *
 *   mode="rest"  (default)    → plain POST, returns the JSON response body
 *   mode="sse"  (auto)        → SSE streaming when onProgress is provided
 *                               AND the workflow has_slow_steps === true
 *   mode="grpc"               → gRPC-Web via sonora (requires peer deps)
 *
 * Manifest caching avoids extra round-trips on repeated calls to the same
 * workflow.  TTL defaults to 60 s and is configurable.
 *
 * Usage:
 *   const client = new TuvlClient({ baseUrl: "http://localhost:8000", token });
 *   const result = await client.execute("screen-candidate", { payload: { candidate_id: 1 } });
 *
 *   // With streaming:
 *   const result = await client.execute("screen-candidate", {
 *     payload: { candidate_id: 1 },
 *     onProgress: (ev) => console.log(ev.step_id, ev.duration_ms),
 *   });
 */

import { parseSseStream } from "./sse";
import { Transport } from "./transport";
import type {
  DoneEvent,
  ErrorEvent,
  ExecuteOptions,
  StepEvent,
  TuvlClientOptions,
  WorkflowManifest,
  WorkflowManifestMap,
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
   * Execute a workflow and return the final output.
   *
   * Transport selection:
   * 1. mode="grpc"            → gRPC-Web (always, regardless of onProgress)
   * 2. mode="sse"             → SSE stream
   * 3. onProgress provided    → SSE if workflow has_slow_steps, else REST
   * 4. default                → REST
   */
  async execute<TOutput = unknown>(
    workflowName: string,
    options: ExecuteOptions<TOutput> = {},
  ): Promise<TOutput> {
    const { payload = {}, onProgress, mode, token, signal } = options;

    // Fetch manifest to resolve trigger_path and streaming hints
    const manifest = await this.getManifest(workflowName, { token, signal });

    const useSse =
      mode === "sse" ||
      (mode !== "rest" && mode !== "grpc" && !!onProgress && manifest.has_slow_steps);

    if (mode === "grpc") {
      return this._executeGrpc<TOutput>(manifest, payload, onProgress, token, signal);
    }

    if (useSse) {
      return this._executeSse<TOutput>(manifest, payload, onProgress, token, signal);
    }

    // Plain REST
    return this.transport.post<Record<string, unknown>, TOutput>(
      manifest.trigger_path,
      payload,
      { token, signal },
    );
  }

  // ── SSE transport ─────────────────────────────────────────────────────────

  private async _executeSse<TOutput>(
    manifest: WorkflowManifest,
    payload: Record<string, unknown>,
    onProgress: ((event: StepEvent) => void) | undefined,
    token: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TOutput> {
    const response = await this.transport.postStream(manifest.trigger_path, payload, {
      token,
      signal,
    });

    let output: TOutput | undefined;

    for await (const frame of parseSseStream(response, signal)) {
      if (frame.event_type === "step") {
        onProgress?.(frame as StepEvent);
      } else if (frame.event_type === "done") {
        output = (frame as DoneEvent).output as TOutput;
      } else if (frame.event_type === "error") {
        const err = frame as ErrorEvent;
        throw new Error(`tuvl workflow error: ${err.message}${err.details ? ` — ${err.details}` : ""}`);
      }
    }

    if (output === undefined) {
      throw new Error("tuvl SSE stream ended without a done event");
    }

    return output;
  }

  // ── gRPC-Web transport ────────────────────────────────────────────────────

  private async _executeGrpc<TOutput>(
    manifest: WorkflowManifest,
    payload: Record<string, unknown>,
    onProgress: ((event: StepEvent) => void) | undefined,
    token: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TOutput> {
    const { openGrpcStream } = await import("./grpc");

    let output: TOutput | undefined;

    for await (const event of openGrpcStream({
      baseUrl: this.transport["baseUrl"] as string,
      workflowName: manifest.name,
      payloadJson: JSON.stringify(payload),
      token,
      signal,
    })) {
      if (event.event_type === "step") {
        onProgress?.(event);
      } else if (event.event_type === "done") {
        output = event.snapshot as unknown as TOutput;
      } else if (event.event_type === "error") {
        throw new Error(`tuvl gRPC error: ${event.error_detail ?? "unknown"}`);
      }
    }

    if (output === undefined) {
      throw new Error("tuvl gRPC stream ended without a done event");
    }

    return output;
  }
}
