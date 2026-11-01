/**
 * `tuvl-client generate [--url <server>] [--file openapi.json] [--out tuvl.generated.ts] [--token <t>]`
 *
 * Kept apart from the executable (`cli.ts`) so a test can call `main` without exiting the process.
 */
import { readFile, writeFile } from "node:fs/promises";
import { countWorkflows, generate, type OpenApiDocument } from "./generate";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(args: string[]): Promise<number> {
  if (args[0] !== "generate") {
    console.error("usage: tuvl-client generate [--url http://localhost:8885] [--file openapi.json] [--out tuvl.generated.ts] [--token <token>]");
    return 2;
  }
  const file = arg(args, "--file");
  const url = arg(args, "--url") ?? process.env.TUVL_URL ?? "http://localhost:8885";
  const out = arg(args, "--out") ?? "tuvl.generated.ts";
  const token = arg(args, "--token") ?? process.env.TUVL_TOKEN;
  let doc: OpenApiDocument;
  let source: string;
  if (file) {
    doc = JSON.parse(await readFile(file, "utf8")) as OpenApiDocument;
    source = file;
  } else {
    source = `${url.replace(/\/$/, "")}/openapi.json`;
    const response = await fetch(source, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) {
      console.error(`tuvl-client: GET ${source} → HTTP ${response.status}`);
      return 1;
    }
    doc = (await response.json()) as OpenApiDocument;
  }
  const code = generate(doc, source);
  await writeFile(out, code);
  const count = countWorkflows(doc);
  console.log(`tuvl-client: wrote ${out} (${count} workflow${count === 1 ? "" : "s"})`);
  return 0;
}
