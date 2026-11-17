// `make smoke` runs this inside a scratch project that has the packed tarball installed, so it sees the package the
// way a consumer does, on whichever Node runs it: both entry points, the run, upload, SSE, CRUD and webhook paths, and the CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const entries = { import: await import("@tuvl/client"), require: require("@tuvl/client") };

const seen = { uploadType: "", resumeUrl: "" };
const connections = { r2: 0 };
const frame = (seq, type) => `id: ${seq}\nevent: ${type}\ndata: {"run_id":"r2","seq":${seq},"type":"${type}","payload":{}}\n\n`;
const server = createServer((req, res) => {
  const json = (body, headers = {}) => {
    res.writeHead(200, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.url.startsWith("/api/runs/r1/events")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('id: 1\nevent: run_started\ndata: {"run_id":"r1","seq":1,"type":"run_started","payload":{}}\n\n');
    return res.end('id: 2\nevent: run_completed\ndata: {"run_id":"r1","seq":2,"type":"run_completed","payload":{}}\n\n');
  }
  if (req.url.startsWith("/api/runs/r2/events")) {
    connections.r2 += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (connections.r2 === 1) {
      res.write(frame(1, "run_started"));
      return setTimeout(() => res.destroy(), 20); // the connection drops with the run still going
    }
    seen.resumeUrl = req.url;
    return res.end(frame(2, "run_completed"));
  }
  if (req.url === "/api/runs/r2") return json({ run_id: "r2", status: "running" });
  if (req.url.startsWith("/models/")) return json([{ id: "1" }]);
  seen.uploadType = req.headers["content-type"] ?? "";
  req.resume();
  req.on("end", () => json({ text: "hi" }, { "x-tuvl-run-id": "r1" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "EdDSA" })}.${b64({ sub: "u", iat: 1 })}.sig`;
const SECRET = "k".repeat(40);
const t = Math.floor(Date.now() / 1000);
const body = JSON.stringify({ id: "n1", type: "run.completed", created_at: "now", workflow: "greet", run_id: "r1", seq: 2 });
const signature = `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
const post = (payload, sent) => new Request("http://app.example.com/hook", { method: "POST", body: payload, headers: { "tuvl-signature": sent } });

const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL  ${name}: ${String(error.message).split("\n")[0]}`);
  }
};

console.log(`Node ${process.version}`);
for (const [kind, tuvl] of Object.entries(entries)) {
  const client = new tuvl.TuvlClient({ baseUrl, token: "t" });
  await check(`${kind}: the public exports are there`, () => {
    for (const name of ["TuvlClient", "TuvlAuth", "CrudClient", "Transport", "parseSseStream", "verifyWebhook", "webhookHandler", "readToken"]) {
      assert.ok(tuvl[name], `missing export ${name}`);
    }
  });
  await check(`${kind}: execute a workflow`, async () => assert.deepEqual(await client.execute("greet", { name: "ada" }), { text: "hi" }));
  await check(`${kind}: execute with a Blob sends multipart/form-data`, async () => {
    await client.execute("greet", { doc: new Blob(["x"]) });
    assert.match(seen.uploadType, /^multipart\/form-data/);
  });
  await check(`${kind}: follow a run's events (SSE)`, async () => {
    const types = [];
    for await (const event of client.runs.events("r1")) types.push(event.type);
    assert.deepEqual(types, ["run_started", "run_completed"]);
  });
  await check(`${kind}: a dropped connection is reopened from where it stopped`, async () => {
    connections.r2 = 0;
    const seqs = [];
    for await (const event of client.runs.events("r2")) seqs.push(event.seq);
    assert.deepEqual(seqs, [1, 2]);
    assert.match(seen.resumeUrl, /from_seq=2/);
  });
  await check(`${kind}: list a model (CRUD)`, async () => assert.deepEqual(await client.crud("candidate").list(), [{ id: "1" }]));
  await check(`${kind}: read a token's claims`, () => assert.equal(tuvl.readToken(token).sub, "u"));
  await check(`${kind}: verify a webhook, and refuse an altered one`, async () => {
    assert.equal((await tuvl.verifyWebhook(body, signature, SECRET)).type, "run.completed");
    await assert.rejects(tuvl.verifyWebhook(`${body} `, signature, SECRET), { reason: "signature" });
  });
  await check(`${kind}: the webhook handler answers 204 and 401`, async () => {
    const handle = tuvl.webhookHandler({ secrets: SECRET, onNotification: () => {} });
    assert.equal((await handle(post(body, signature))).status, 204);
    assert.equal((await handle(post(`${body} `, signature))).status, 401);
  });
}

const cli = join(dirname(require.resolve("@tuvl/client")), "cli.js");
await check("cli: usage without arguments exits 2", () => {
  const run = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: tuvl-client generate/);
});
await check("cli: generate types from an OpenAPI file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tuvl-smoke-cli-"));
  const schema = (properties) => ({ type: "object", properties, required: Object.keys(properties) });
  const openapi = {
    paths: {
      "/api/greet": {
        post: {
          "x-tuvl-workflow": "greet",
          requestBody: { content: { "application/json": { schema: schema({ name: { type: "string" } }) } } },
          responses: { 200: { description: "END", content: { "application/json": { schema: schema({ text: { type: "string" } }) } } } },
        },
      },
    },
  };
  writeFileSync(join(dir, "openapi.json"), JSON.stringify(openapi));
  const run = spawnSync(process.execPath, [cli, "generate", "--file", join(dir, "openapi.json"), "--out", join(dir, "out.ts")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const generated = readFileSync(join(dir, "out.ts"), "utf8");
  assert.match(generated, /greet: \{/);
  assert.match(generated, /name: string;/);
});

server.close();
if (failures.length > 0) {
  console.error(`${failures.length} smoke check(s) failed on Node ${process.version}`);
  process.exit(1);
}
