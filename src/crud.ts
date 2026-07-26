/**
 * CrudClient — typed CRUD access for tuvl model endpoints.
 *
 * The tuvl server mounts auto-generated CRUD routers at:
 *   /models/{modelname}/          (list, create)
 *   /models/{modelname}/{id}      (get, update, delete)
 *
 * Usage via TuvlClient.crud():
 *
 * ```ts
 * const client = new TuvlClient({ baseUrl: "http://localhost:8885", token });
 *
 * // List all candidates
 * const all = await client.crud("candidate").list();
 *
 * // Filter + embed relations
 * const results = await client.crud("candidate").list({
 *   filters: { stage: "screening" },
 *   include: ["posting"],
 *   limit: 50,
 * });
 *
 * // Get one
 * const c = await client.crud("candidate").get("uuid-here");
 *
 * // Create
 * const created = await client.crud<CandidateRead, CandidateCreate>("candidate")
 *   .create({ name: "Alice", email: "alice@example.com" });
 *
 * // Update
 * const updated = await client.crud("candidate").update("uuid", { stage: "interview" });
 *
 * // Delete
 * await client.crud("candidate").delete("uuid");
 * ```
 *
 * Type parameters:
 *   TRead   — shape returned by GET / POST / PATCH (defaults to `unknown`)
 *   TCreate — body for POST (defaults to `Partial<TRead>`)
 *   TUpdate — body for PATCH (defaults to `Partial<TRead>`)
 */

import type { Transport } from "./transport";
import type { CrudGetOptions, CrudListOptions, CrudMutateOptions } from "./types";

export class CrudClient<
  TRead = unknown,
  TCreate = Partial<TRead>,
  TUpdate = Partial<TRead>,
> {
  private readonly basePath: string;

  constructor(
    private readonly transport: Transport,
    modelName: string,
  ) {
    this.basePath = `/models/${modelName.toLowerCase()}`;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Build query string from list options. */
  private _buildQuery(options: CrudListOptions): string {
    const params = new URLSearchParams();

    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));

    if (options.filters) {
      for (const [key, value] of Object.entries(options.filters)) {
        params.set(`filter[${key}]`, value);
      }
    }

    if (options.include && options.include.length > 0) {
      params.set("include", options.include.join(","));
    }

    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  /** Build ?include= query string for get-by-id calls. */
  private _buildGetQuery(options: CrudGetOptions): string {
    if (!options.include || options.include.length === 0) return "";
    const params = new URLSearchParams({ include: options.include.join(",") });
    return `?${params.toString()}`;
  }

  // ── Public CRUD methods ──────────────────────────────────────────────────

  /**
   * GET /models/{model}/
   * Returns all records matching the given filters (server default: up to 100).
   */
  async list(options: CrudListOptions = {}): Promise<TRead[]> {
    const qs = this._buildQuery(options);
    return this.transport.get<TRead[]>(`${this.basePath}/${qs}`, {
      token: options.token,
      signal: options.signal,
    });
  }

  /**
   * GET /models/{model}/{id}
   * Returns a single record by UUID, optionally with embedded relations.
   */
  async get(id: string, options: CrudGetOptions = {}): Promise<TRead> {
    const qs = this._buildGetQuery(options);
    return this.transport.get<TRead>(`${this.basePath}/${encodeURIComponent(id)}${qs}`, {
      token: options.token,
      signal: options.signal,
    });
  }

  /**
   * POST /models/{model}/
   * Creates a new record and returns the created resource (HTTP 201).
   */
  async create(body: TCreate, options: CrudMutateOptions = {}): Promise<TRead> {
    return this.transport.post<TCreate, TRead>(`${this.basePath}/`, body, {
      token: options.token,
      signal: options.signal,
    });
  }

  /**
   * PATCH /models/{model}/{id}
   * Partially updates a record (only fields present in `body` are changed).
   */
  async update(id: string, body: TUpdate, options: CrudMutateOptions = {}): Promise<TRead> {
    return this.transport.patch<TUpdate, TRead>(
      `${this.basePath}/${encodeURIComponent(id)}`,
      body,
      { token: options.token, signal: options.signal },
    );
  }

  /**
   * DELETE /models/{model}/{id}
   * Deletes a record (HTTP 204). Throws if the record is not found.
   */
  async delete(id: string, options: CrudMutateOptions = {}): Promise<void> {
    return this.transport.delete(`${this.basePath}/${encodeURIComponent(id)}`, {
      token: options.token,
      signal: options.signal,
    });
  }
}
