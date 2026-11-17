/**
 * The release pipeline publishes without a stored token (npm trusted publishing), from actions pinned to a commit, for a
 * protected environment, and only what was tested.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const release = read(".github/workflows/release.yml");
const withoutComments = release
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");
const at = (text: string) => release.indexOf(text);

describe("the workflows", () => {
  it.each([".github/workflows/ci.yml", ".github/workflows/release.yml"])("%s pins every action to a commit", (file) => {
    const refs = [...read(file).matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) => match[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });
});

describe("the release workflow", () => {
  it("holds no npm token: trusted publishing needs none", () => {
    expect(withoutComments).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
    expect(release).toMatch(/permissions:\s+contents: read\s+id-token: write/);
  });

  it("runs for the protected environment the trusted publisher names, on a GitHub-hosted runner", () => {
    expect(release).toMatch(/^\s+environment: npm-publish$/m);
    expect(release).toMatch(/^\s+runs-on: ubuntu-latest$/m);
    expect(read("CONTRIBUTING.md")).toContain("environment `npm-publish`");
  });

  it("uses a Node and an npm that support trusted publishing (Node 22.14, npm 11.5.1)", () => {
    expect(Number(/node-version:\s*"(\d+)"/.exec(release)?.[1])).toBeGreaterThanOrEqual(24);
    expect(release).toContain("npm@^11.5.1");
  });

  it("refuses a tag that is not on main or does not match package.json, before anything is built", () => {
    const guards = [at("merge-base --is-ancestor"), at('GITHUB_REF_NAME#v')];
    expect(guards.every((index) => index > 0)).toBe(true);
    expect(Math.max(...guards)).toBeLessThan(at("pnpm install"));
  });

  it("tests and smoke-tests the package before it publishes, and publishes with provenance", () => {
    for (const step of ["pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build", "make smoke"]) {
      expect(at(step), step).toBeGreaterThan(0);
      expect(at(step), step).toBeLessThan(at("npm publish"));
    }
    expect(release).toContain("--provenance");
  });

  it("puts a prerelease under its own dist-tag, so latest does not move", () => {
    expect(release).toMatch(/--tag "\$\{PRE%%\.\*\}"/);
  });

  it("is documented where a maintainer will look", () => {
    const contributing = read("CONTRIBUTING.md");
    for (const setting of ["tuvl-io", "tuvl-npm", "release.yml", "npm-publish", "v*.*.*"]) expect(contributing).toContain(setting);
    expect(contributing).toMatch(/Do not add an `NPM_TOKEN`/);
  });
});
