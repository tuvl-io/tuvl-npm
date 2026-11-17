/**
 * Which Node.js lines the package supports, said once and checked everywhere it is claimed: the floor in
 * package.json, the README, CONTRIBUTING, the CLI build target, the typings and the CI matrix. The suite runs on
 * every line in the matrix, so the platform cases below are checked on Node 22, 24 and 26.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Node's own supported lines (not end of life). The first is the floor; add the next line here when it ships. */
const SUPPORTED = [22, 24, 26];
const FLOOR = SUPPORTED[0];

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const major = (version: string) => Number(version.replace(/^\D+/, "").split(".")[0]);
const ci = () => read(".github/workflows/ci.yml");

function matrix(): number[] {
  const found = /node:\s*\[([^\]]*)\]/.exec(ci());
  return found ? (JSON.parse(`[${found[1]}]`) as string[]).map(Number) : [];
}

describe("the supported Node.js lines", () => {
  it("package.json asks for the floor and nothing older", () => {
    const engines = (JSON.parse(read("package.json")) as { engines: { node: string } }).engines;
    expect(engines.node).toBe(`>=${FLOOR}`);
  });

  it.each(SUPPORTED)("CI runs the suite on Node %i", (line) => {
    expect(matrix()).toContain(line);
  });

  it("CI runs exactly the supported lines: none older, none the package does not claim", () => {
    expect(matrix()).toEqual(SUPPORTED);
  });

  it("CI also exercises the packed package on each line", () => {
    expect(ci()).toContain("make smoke");
  });

  it("the release is published from a supported line", () => {
    const release = /node-version:\s*"(\d+)"/.exec(read(".github/workflows/release.yml"));
    expect(SUPPORTED).toContain(Number(release?.[1]));
  });

  it("the typings follow the floor, so nothing newer than it compiles", () => {
    const dev = (JSON.parse(read("package.json")) as { devDependencies: Record<string, string> }).devDependencies;
    expect(major(dev["@types/node"])).toBe(FLOOR);
  });

  it("the CLI bundle is built for the floor", () => {
    expect(read("tsup.config.mts")).toContain(`target: "node${FLOOR}"`);
  });

  it.each(["README.md", "CONTRIBUTING.md"])("%s names the floor and the lines CI runs, and no older Node", (file) => {
    const text = read(file);
    expect(text).toMatch(new RegExp(`Node\\.js ${FLOOR}( or| and) newer`));
    expect(text).toContain(`${SUPPORTED.slice(0, -1).join(", ")} and ${SUPPORTED.at(-1)}`);
    expect(text).not.toMatch(/Node(\.js)? 18/);
  });

  it("the webhook verifier does not promise an older Node than the floor", () => {
    const source = read("src/webhooks.ts");
    expect(source).toContain(`Works in Node ${FLOOR}+`);
    expect(source).not.toMatch(/Node 18/);
  });

  it(`this run is on a supported line (Node ${process.versions.node})`, () => {
    expect(SUPPORTED).toContain(major(process.versions.node));
  });
});

describe("what the client needs from the platform", () => {
  const globals: [string, () => unknown][] = [
    ["crypto.subtle", () => globalThis.crypto?.subtle],
    ["fetch", () => globalThis.fetch],
    ["Request", () => globalThis.Request],
    ["Response", () => globalThis.Response],
    ["Headers", () => globalThis.Headers],
    ["FormData", () => globalThis.FormData],
    ["Blob", () => globalThis.Blob],
    ["ReadableStream", () => globalThis.ReadableStream],
    ["AbortController", () => globalThis.AbortController],
    ["TextEncoder", () => globalThis.TextEncoder],
    ["TextDecoder", () => globalThis.TextDecoder],
    ["atob", () => globalThis.atob],
  ];

  it.each(globals)("%s is available", (_name, get) => {
    expect(get()).toBeDefined();
  });

  it("Web Crypto can verify an HMAC, which is how a webhook is checked", async () => {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const message = new TextEncoder().encode("1700000000.body");
    const mac = await crypto.subtle.sign("HMAC", key, message);
    await expect(crypto.subtle.verify("HMAC", key, mac, message)).resolves.toBe(true);
  });

  it("a streamed request body can be cancelled, which is how an oversized webhook is cut off", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(1024)),
      cancel: () => {
        cancelled = true;
      },
    });
    const reader = new Request("https://app.example.com/hook", { method: "POST", body, duplex: "half" } as RequestInit).body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(cancelled).toBe(true);
  });
});
