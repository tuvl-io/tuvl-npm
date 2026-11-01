import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import doc from "./__fixtures__/openapi.json";
import { main } from "./cli-main";

const mockFetch = vi.fn<typeof fetch>();
let dir: string;
let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  dir = await mkdtemp(join(tmpdir(), "tuvl-client-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("tuvl-client generate", () => {
  it("writes the types from a file and says how many workflows", async () => {
    const file = join(dir, "openapi.json");
    const out = join(dir, "out.ts");
    await writeFile(file, JSON.stringify(doc));
    expect(await main(["generate", "--file", file, "--out", out])).toBe(0);
    expect(await readFile(out, "utf8")).toContain("triage_ticket: {");
    expect(log).toHaveBeenCalledWith(`tuvl-client: wrote ${out} (1 workflow)`);
  });

  it("fetches /openapi.json from the server with the token", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(doc)));
    const out = join(dir, "out.ts");
    expect(await main(["generate", "--url", "http://srv:8885/", "--token", "tok", "--out", out])).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://srv:8885/openapi.json");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("counts several workflows in the plural", async () => {
    const file = join(dir, "two.json");
    const op = (name: string) => ({ post: { "x-tuvl-workflow": name, responses: { "200": { description: "END" } } } });
    await writeFile(file, JSON.stringify({ paths: { "/a": op("a"), "/b": op("b") } }));
    expect(await main(["generate", "--file", file, "--out", join(dir, "o.ts")])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("(2 workflows)"));
  });

  it("exits 1 when the server refuses", async () => {
    mockFetch.mockResolvedValueOnce(new Response("no", { status: 401 }));
    expect(await main(["generate", "--out", join(dir, "o.ts")])).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"));
  });

  it("exits 2 with the usage for anything but generate", async () => {
    expect(await main([])).toBe(2);
    expect(await main(["build"])).toBe(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("usage: tuvl-client generate"));
  });
});
