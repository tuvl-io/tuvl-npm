/**
 * RolesClient — role membership for an application's own screen.
 *
 * Wraps the server's `roles` API group (`/auth/roles`, tuvl >= 2.1.0b2): list the roles, find users,
 * add or remove a member, disable or re-enable a role. That is all it does. Creating or deleting roles,
 * changing what a role grants, creating users and federation are development-time work (`RoleSeed`,
 * `tuvl iam`) and have no route, so they are not wrapped here.
 *
 * The group is **not mounted on a production server** until the operator adds `roles` to
 * `spec.api.expose` / `TUVL_API_EXPOSE`. The caller's token needs the `roles:manage` scope.
 * A caller without `iam:admin` can change a role only if every scope it grants is one they hold
 * themselves, and never a role carrying `iam:admin` or `roles:manage`; the server answers 403 with
 * the reason. A manager token is a privileged secret: keep it short-lived, and do not hand it to
 * pages that do not need it.
 *
 * ```ts
 * const client = new TuvlClient({ baseUrl, token });
 * const roles = client.roles();
 *
 * if (await roles.isAvailable()) {
 *   const all = await roles.list();
 *   const { items } = await roles.findUsers({ q: "alice" });
 *   await roles.addUser(all[0].id, items[0].id);
 *   await roles.setActive(all[0].id, false); // disable the role
 * }
 * ```
 */

import { detail, type Transport } from "./transport";
import type { Page, RequestOptions, Role, RoleMember } from "./types";
import { TuvlApiError } from "./types";

const BASE = "/auth/roles";

/** Paging for the member and user lists. `cursor` is the previous page's `next_cursor`. */
export interface PageOptions extends RequestOptions {
  limit?: number;
  cursor?: string;
}

export interface FindUsersOptions extends PageOptions {
  /** Part of an email or a name (case-insensitive). */
  q?: string;
}

const id = encodeURIComponent;

export class RolesClient {
  constructor(private readonly transport: Transport) {}

  /**
   * Whether the server mounts the roles API. A 401 or 403 means it does (the token is the problem);
   * a 404 means the operator has not exposed `roles`. Any other refusal rejects with {@link TuvlApiError}.
   */
  async isAvailable(options?: RequestOptions): Promise<boolean> {
    const response = await this.transport.request("GET", BASE, options);
    if (response.ok || response.status === 401 || response.status === 403) return true;
    if (response.status === 404) return false;
    throw new TuvlApiError(response.status, await detail(response), BASE);
  }

  /** Every role, with what it grants (read-only), whether it is active, and its member count. */
  list(options?: RequestOptions): Promise<Role[]> {
    return this.transport.json<Role[]>("GET", BASE, options);
  }

  /** One page of a role's members, ordered by email. */
  members(roleId: string, { limit, cursor, ...options }: PageOptions = {}): Promise<Page<RoleMember>> {
    return this.transport.json<Page<RoleMember>>("GET", `${BASE}/${id(roleId)}/members`, {
      query: { limit, cursor },
      ...options,
    });
  }

  /** One page of users to pick from, ordered by email; `q` narrows by email or name. */
  findUsers({ q, limit, cursor, ...options }: FindUsersOptions = {}): Promise<Page<RoleMember>> {
    return this.transport.json<Page<RoleMember>>("GET", `${BASE}/candidates`, {
      query: { q, limit, cursor },
      ...options,
    });
  }

  /** Add a user to a role. Adding a member twice is harmless. */
  async addUser(roleId: string, userId: string, options?: RequestOptions): Promise<void> {
    await this.transport.send("PUT", `${BASE}/${id(roleId)}/members/${id(userId)}`, options);
  }

  /** Remove a user from a role. Rejects with a 404 {@link TuvlApiError} if they were not a member. */
  async removeUser(roleId: string, userId: string, options?: RequestOptions): Promise<void> {
    await this.transport.send("DELETE", `${BASE}/${id(roleId)}/members/${id(userId)}`, options);
  }

  /**
   * Disable (`false`) or enable (`true`) a role. A disabled role keeps its members and scopes but
   * grants nothing, and its members' sessions end. Returns the role as it now stands.
   */
  setActive(roleId: string, active: boolean, options?: RequestOptions): Promise<Role> {
    return this.transport.json<Role>("PATCH", `${BASE}/${id(roleId)}`, {
      body: { is_active: active },
      ...options,
    });
  }

  /** Disable a role. See {@link RolesClient.setActive}. */
  disable(roleId: string, options?: RequestOptions): Promise<Role> {
    return this.setActive(roleId, false, options);
  }

  /** Enable a role. See {@link RolesClient.setActive}. */
  enable(roleId: string, options?: RequestOptions): Promise<Role> {
    return this.setActive(roleId, true, options);
  }
}
