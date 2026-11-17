/**
 * `tuvl-client generate [--url <server>] [--file openapi.json] [--out tuvl.generated.ts] [--token <t>]`
 *
 * Kept apart from the executable (`cli.ts`) so a test can call `main` without exiting the process.
 */
import { readFile, writeFile } from "node:fs/promises";
import { countWorkflows, generate, type OpenApiDocument } from "./generate";

const USAGE = `usage: tuvl-client generate [--url <server>] [--file <openapi.json>] [--out <file>] [--token <token>]

  --url <server>   the tuvl server to read /openapi.json from (default: $TUVL_URL, else http://localhost:8885)
  --file <path>    read a saved openapi.json instead of asking a server (not with --url)
  --out <file>     where to write the types (default: tuvl.generated.ts)
  --token <token>  a bearer token for a server that needs one; $TUVL_TOKEN is safer (a flag shows in the process list)
  -h, --help       this text`;

const VALUE_FLAGS = new Set(["--url", "--file", "--out", "--token"]);

type Parsed = { options: Map<string, string> } | { help: true } | { error: string };

/** `--flag value` and `--flag=value`. A flag nobody knows, a flag without its value and a stray word are mistakes. */
function parse(args: string[]): Parsed {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") return { help: true };
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (!arg.startsWith("-")) return { error: `unexpected argument "${arg}"` };
    if (!VALUE_FLAGS.has(name)) return { error: `unknown option ${name}` };
    const value = equals > 0 ? arg.slice(equals + 1) : args[++i];
    if (value === undefined || value === "" || (equals < 0 && value.startsWith("-"))) return { error: `${name} needs a value` };
    options.set(name, value);
  }
  return { options };
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "-h" || command === "--help") {
    console.log(USAGE);
    return 0;
  }
  if (command !== "generate") {
    console.error(USAGE);
    return 2;
  }
  const parsed = parse(rest);
  if ("help" in parsed) {
    console.log(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    console.error(`tuvl-client: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { options } = parsed;
  const file = options.get("--file");
  if (file && options.has("--url")) {
    console.error(`tuvl-client: use --file or --url, not both\n\n${USAGE}`);
    return 2;
  }
  const url = options.get("--url") ?? process.env.TUVL_URL ?? "http://localhost:8885";
  const out = options.get("--out") ?? "tuvl.generated.ts";
  const token = options.get("--token") ?? process.env.TUVL_TOKEN;
  if (options.has("--token")) console.error("tuvl-client: a token given as --token is visible to other users of this machine; TUVL_TOKEN is safer");
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
