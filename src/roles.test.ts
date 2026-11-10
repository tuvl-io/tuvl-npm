/**
 * Tests for RolesClient — role membership.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TuvlClient } from "./client";
import { RolesClient } from "./roles";
import { Transport } from "./transport";
import { TuvlApiError } from "./types";

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const empty = (status = 204): Response => new Response(null, { status });

const roles = (): RolesClient => new RolesClient(new Transport({ baseUrl: "http://srv/", defaultToken: "tok" }));

function lastCall(): { url: string; init: RequestInit; headers: Record<string, string> } {
  const [url, init] = mockFetch.mock.calls.at(-1) ?? [];
  return { url: String(url), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> };
}

const role = {
  id: "r1",
  name: "reviewers",
  description: null,
  is_active: true,
  scopes: ["reports:read"],
  member_count: 2,
};

describe("RolesClient", () => {
  it("is reached from the client and shares its token", async () => {
    mockFetch.mockResolvedValueOnce(json([role]));
    const result = await new TuvlClient({ baseUrl: "http://srv", token: "abc" }).roles().list();
    expect(result).toEqual([role]);
    expect(lastCall().url).toBe("http://srv/auth/roles");
    expect(lastCall().headers["Authorization"]).toBe("Bearer abc");
  });

  it("list() reads /auth/roles", async () => {
    mockFetch.mockResolvedValueOnce(json([role]));
    expect(await roles().list()).toEqual([role]);
    const { url, init } = lastCall();
    expect(url).toBe("http://srv/auth/roles");
    expect(init.method).toBe("GET");
  });

  it("members() pages with limit and cursor", async () => {
    const page = { items: [{ id: "u1", email: "a@x.io", first_name: null, last_name: null, is_active: true }], next_cursor: "a@x.io" };
    mockFetch.mockResolvedValueOnce(json(page));
    expect(await roles().members("r 1", { limit: 2, cursor: "z@x.io" })).toEqual(page);
    expect(lastCall().url).toBe("http://srv/auth/roles/r%201/members?limit=2&cursor=z%40x.io");
  });

  it("findUsers() sends only the filters it was given", async () => {
    mockFetch.mockResolvedValueOnce(json({ items: [], next_cursor: null }));
    await roles().findUsers({ q: "ali" });
    expect(lastCall().url).toBe("http://srv/auth/roles/candidates?q=ali");
    mockFetch.mockResolvedValueOnce(json({ items: [], next_cursor: null }));
    await roles().findUsers();
    expect(lastCall().url).toBe("http://srv/auth/roles/candidates");
  });

  it("addUser() PUTs the membership and resolves on 204", async () => {
    mockFetch.mockResolvedValueOnce(empty());
    await expect(roles().addUser("r1", "u1")).resolves.toBeUndefined();
    const { url, init } = lastCall();
    expect(url).toBe("http://srv/auth/roles/r1/members/u1");
    expect(init.method).toBe("PUT");
  });

  it("removeUser() DELETEs the membership; a non-member is a 404 TuvlApiError", async () => {
    mockFetch.mockResolvedValueOnce(empty());
    await roles().removeUser("r1", "u1");
    expect(lastCall().init.method).toBe("DELETE");
    mockFetch.mockResolvedValueOnce(json({ detail: "Assignment not found." }, 404));
    await expect(roles().removeUser("r1", "u2")).rejects.toMatchObject({ status: 404, detail: "Assignment not found." });
  });

  it("setActive(), disable() and enable() PATCH only is_active and return the role", async () => {
    mockFetch.mockResolvedValueOnce(json({ ...role, is_active: false }));
    const off = await roles().disable("r1");
    expect(off.is_active).toBe(false);
    const { url, init } = lastCall();
    expect(url).toBe("http://srv/auth/roles/r1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ is_active: false });
    mockFetch.mockResolvedValueOnce(json(role));
    await roles().enable("r1");
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ is_active: true });
  });

  it("a refusal for access beyond the caller's own is a 403 TuvlApiError with the reason", async () => {
    mockFetch.mockResolvedValueOnce(json({ detail: "Role 'approvers' grants scopes you do not hold (payments:approve)." }, 403));
    const error = await roles().addUser("r1", "u1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TuvlApiError);
    expect(error).toMatchObject({ status: 403 });
    expect(String((error as TuvlApiError).detail)).toContain("payments:approve");
  });

  it("a per-call token and signal override the client's", async () => {
    mockFetch.mockResolvedValueOnce(json([]));
    const controller = new AbortController();
    await roles().list({ token: "other", signal: controller.signal });
    expect(lastCall().headers["Authorization"]).toBe("Bearer other");
    expect(lastCall().init.signal).toBe(controller.signal);
  });

  describe("isAvailable()", () => {
    it("is true when the group answers, even with a refusal for the token", async () => {
      for (const status of [200, 401, 403]) {
        mockFetch.mockResolvedValueOnce(json(status === 200 ? [] : { detail: "no" }, status));
        expect(await roles().isAvailable()).toBe(true);
      }
    });

    it("is false when the server does not mount the group", async () => {
      mockFetch.mockResolvedValueOnce(json({ detail: "Not Found" }, 404));
      expect(await roles().isAvailable()).toBe(false);
    });

    it("rejects on any other failure", async () => {
      mockFetch.mockResolvedValueOnce(json({ detail: "boom" }, 500));
      await expect(roles().isAvailable()).rejects.toMatchObject({ status: 500 });
    });
  });
});
