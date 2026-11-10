# @tuvl/client

[![npm](https://img.shields.io/npm/v/@tuvl/client)](https://www.npmjs.com/package/@tuvl/client)
[![CI](https://github.com/tuvl-io/tuvl-npm/actions/workflows/ci.yml/badge.svg)](https://github.com/tuvl-io/tuvl-npm/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@tuvl/client)](LICENSE)

> `@tuvl/client` 2.x targets engine `tuvl >= 2.0`: REST + Server-Sent Events
> only. Breaking changes bump the major version ([SemVer](https://semver.org)).

TypeScript client for the [tuvl](https://tuvl.io) workflow engine: start workflow
runs, follow their journal over SSE, operate them, decide approvals, and use
typed CRUD on models. `npx tuvl-client generate` turns the server's
`/openapi.json` into typed workflow inputs and outputs.

---

## Installation

```bash
npm install @tuvl/client
# or
pnpm add @tuvl/client
```

It runs on Node.js 18 or newer (or a browser, Deno, Bun or an edge runtime) and has no runtime dependencies. CI tests Node.js 22, 24 and 26; older runtimes are not tested. It talks to a
tuvl `2.0` server, which you install with `uv tool install "tuvl[standard]"` ([install guide](https://tuvl.dev/getting-started/installation/)).

---

## Quick start

```ts
import { RunHandle, TuvlClient } from "@tuvl/client";
import type { Workflows } from "./tuvl.generated"; // npx tuvl-client generate

const client = new TuvlClient<Workflows>({ baseUrl: "http://localhost:8885", token });

const result = await client.execute("triage_ticket", {
  subject: "Refund",
  body: "I was charged twice",
  customer_email: "a@example.com",
});

if (result instanceof RunHandle) {
  // the run waits on a person or outlived the trigger's sync_timeout
  for await (const event of result.events()) console.log(event.seq, event.type, event.agent_id);
  console.log(await result.wait());
} else {
  console.log(result.category, result.urgency); // typed from the default end
}
```

---

## Typed workflows

```bash
npx tuvl-client generate --url http://localhost:8885 --out src/tuvl.generated.ts
# or from a saved document
npx tuvl-client generate --file openapi.json
```

Every trigger route in `/openapi.json` carries `x-tuvl-workflow`. The generator
emits one `Workflows` type: per workflow its `input` (path, query and body
fields of `trigger.input`), its `output` (the default end's body) and `ends`
(every end's body by HTTP status). Without it, `TuvlClient` accepts any
workflow name with untyped input and output.

---

## Runs

### `client.execute(workflow, input, options?)`

`POST /api/workflows/{name}/runs` and wait up to the trigger's `sync_timeout`.

| Server answer | `execute()` |
|---|---|
| 2xx end | resolves the end's body |
| `202` (still running, or waiting on a person/approval) | resolves a `RunHandle` |
| end with status ≥ 400, failure, abort | rejects `TuvlRunError { status, body, runId }` |
| refused (401/403/404, input not matching `trigger.input` → 422) | rejects `TuvlApiError { status, detail }` |

`client.start(workflow, input)` starts without waiting and returns a `RunHandle`.

**Files.** For a workflow whose trigger has `http.upload`, pass a `File` or `Blob` as the value of a
`file` input (an array for `list[file]`). The client then sends `multipart/form-data`: files as file parts,
objects and arrays as JSON text, everything else as text. The server stores the file and hands the workflow a
reference; the answer is the same as for any run. `tuvl-client generate` types such inputs as `Blob`.

```ts
await client.execute("intake", { invoice: fileInput.files[0], note: "March" });
```

### Webhooks: be told instead of polling

A workflow can declare webhooks (`spec.webhooks` in its YAML; the engine's `docs/webhooks.md` covers the
server side). A notification says only that a run reached a stage: the run id, what happened and a journal
position. It carries no input or output, so you pull what you need with your own token.

```ts
import { TuvlClient, webhookHandler } from "@tuvl/client";

const client = new TuvlClient({ baseUrl: "https://tuvl.example.com", token: serviceToken }); // scope runs:read

// Next.js route handler, Cloudflare Worker, Deno, Bun, Hono … anything that speaks Request/Response
export const POST = webhookHandler({
  secrets: [process.env.OPS_WEBHOOK_SECRET!],            // add the old secret too while rotating
  onNotification: async (n) => {
    if (await alreadySeen(n.id)) return;                 // delivery is at-least-once
    const run = await client.run(n.run_id).get();        // pull with your own token
    await pushToDevices(run);
  },
});
```

For Express, give the route the raw body (`express.raw({ type: "application/json" })`) and call
`verifyWebhook(req.body, req.header("tuvl-signature"), secrets)`; it throws `WebhookError` (answer 401) unless the
signature matches, the body is untouched and the timestamp is within five minutes. Never verify a re-serialised
body. `client.runs.webhooks(runId)` lists a run's notifications and `redeliverWebhook` sends one again.

A phone should not hold the secret: receive on your backend, verify, then push only the run id to the device
(FCM, APNs, ntfy). The app pulls the run with the user's own token.

### Showing an answer while the model writes it

An `llm` agent declared with `stream_tokens: true` (and, when it has several `str` outputs, `stream_field`) sends the text
of that output to the run's event stream as it is produced, so a UI is not frozen for the length of the call. Ask for it with
`onToken`, `tokens()` or `stream()`; plain `events()` is unchanged and never receives drafts.

```ts
const handle = client.run(runId); // or the RunHandle that execute() returned

const live = handle.onToken((piece) => (box.textContent += piece), {
  onReset: () => (box.textContent = ""), // the agent is starting its answer again: drop the draft
});
const output = await handle.wait(); // the final, validated result as always
await live.done;
```

- A **piece** is the next part of the text. A client that joins while the agent is running first gets the draft so far in one
  piece (`replay: true` on the event).
- A **reset** (`token_reset`) means discard what you showed: the agent retried, or its answer was rejected. The finished result is
  in the run output (`wait()`), never only in the pieces, so a client that missed some loses nothing.
- `tokens({ agentId? })` is the same as an async iterator of `token_delta` and `token_reset`; `stream()` yields them together with
  the journal events, told apart by `type` (`isTokenEvent(event)` narrows).
- Drafts are not journaled and are not kept: they exist while the run is running. A model that reasons before it answers sends
  nothing until its answer starts.

### `RunHandle`

| Member | |
|---|---|
| `id`, `run` | run id; the run as last seen |
| `get()` | refresh (`GET /api/runs/{id}`) |
| `events({ fromSeq?, follow? })` | async iterator of `RunEvent` over SSE: replay, then live until the run ends |
| `onToken(listener, { onReset?, agentId? })` | call `listener(piece)` for each piece of an answer as it is written; returns `{ stop, done }` |
| `tokens({ agentId? })`, `stream({ fromSeq?, follow? })` | async iterators of live drafts only, or of journal events and drafts together |
| `wait({ intervalMs?, timeoutMs?, untilWaiting? })` | poll until the run ends; resolves the output or rejects `TuvlRunError`. `untilWaiting` also stops when it waits on a person |
| `pause()`, `resume()`, `abort()`, `steer(message)` | operator control (scope `runs:control`) |

`client.run(id)` gives a handle on any run.

### `client.runs`

`list({ workflow?, status?, limit? })`, `get(id)`, `events(id, opts)`, `stream(id, opts)`, `tokens(id, opts)`,
`control(id, action, message?)`, `export(id)` (the journal as a replayable
fixture).

### `client.approvals`

```ts
const [approval] = await client.approvals.list(); // what the caller may decide
await client.approvals.decide(approval.approval_id, { values: { approved: true } }); // human form
await client.approvals.decide(toolApproval.approval_id, { decision: "edit", edited_args: { amount: 10 } }); // tool call
```

Needs scope `approvals:decide` plus the agent's `required_group`.

### `RunEvent`

`{ run_id, seq, ts, type, agent_id, engine, tokens, latency_ms, payload }` — `type`
is one of `run_queued`, `run_started`, `agent_started`, `agent_completed`,
`signal`, `llm_turn`, `tool_call`, `tool_result`, `decision`, `judge_verdict`,
`approval_requested`, `approval_decided`, `paused`, `resumed`, `checkpoint`,
`compensation_started`, `compensation_completed`, `run_completed`,
`run_failed`, `run_aborted`.

---

## Authentication

The `TuvlAuth` class wraps the most common `/auth/*` endpoints — `bootstrap`, `loginWithPassword`, `getOAuthLoginUrl`, `getMe`, `refresh`, `logout` — so you don't have to hand-craft form bodies. Each takes an optional `{ signal }` to cancel it, and a refused request rejects with `TuvlApiError { status, detail, path }`, the same as every other call. Admin endpoints (user / role / scope CRUD, federation config) are intentionally not wrapped; call them directly with `fetch` or the lower-level `Transport` using the same Bearer token.

### `new TuvlAuth(options)`

| Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | tuvl server URL |

### Password login

```ts
const auth = new TuvlAuth({ baseUrl: "http://localhost:8885" });
const { access_token } = await auth.loginWithPassword("me@example.com", "secret");
```

### Bootstrap (one-time IAM init)

```ts
// First call ever: creates the superadmin user and returns a token.
// Every subsequent call rejects with HTTP 409.
const { access_token } = await auth.bootstrap({
  email: "admin@example.com",
  password: "change-me-now",
  admin_scope: "iam:admin",
});
```

### OAuth2 login (browser)

```ts
// Redirect the browser to the provider's login page
window.location.href = auth.getOAuthLoginUrl("google"); // or "github" / "microsoft"

// On the landing page (TUVL_OAUTH_UI_REDIRECT_URL), pick up the token:
const token = new URLSearchParams(window.location.search).get("token")!;
```

### Read the token locally

Access tokens are Ed25519-signed JWTs, so their claims are readable on the client — enough to
show who is signed in and to refresh before expiry:

```ts
import { isTokenExpired, readToken } from "@tuvl/client";

const claims = readToken(token);   // { sub, groups, scopes, tenant?, iat, exp?, ... }
if (isTokenExpired(token)) {       // expired, or within 30 s of it
  token = (await auth.refresh(token)).access_token;
}
```

`readToken` does **not** verify the signature — use it for display, not for access decisions in
a client you don't control. The server is the authority, and only it knows about logouts and
ended sessions. Services that verify tokens themselves can fetch tuvl's public key from
`GET /auth/jwks.json` (`alg: EdDSA`).

### Get current user identity and roles

`getMe()` asks the server, so it also fails for a revoked token or a user whose sessions were
ended:

```ts
const me = await auth.getMe(token);
// me.user_id  — user UUID
// me.groups   — role names e.g. ["hr_manager", "member"]
// me.scopes   — permission scopes e.g. ["candidate:read"]

if (me.groups.includes("hr_manager")) {
  // show HR features
}

if (me.scopes.includes("iam:admin")) {
  // show admin panel
}
```

### Token refresh

```ts
const { access_token: newToken } = await auth.refresh(currentToken);
client.setToken(newToken); // update the workflow client in-place
```

### Logout

```ts
await auth.logout(token);
// delete token from localStorage / state after this
```

---

## CRUD — model data access

`client.crud(modelName)` returns a `CrudClient` that targets the auto-generated REST endpoints at `/models/{modelname}/`. The token and base URL are shared with the parent `TuvlClient`. In tuvl 2.0 CRUD is off by default: a model opts in per operation with `spec.api.crud: [list, read, create, update, delete]`.

```ts
import { TuvlClient } from "@tuvl/client";

const client = new TuvlClient({ baseUrl: "http://localhost:8885", token });

// List all candidates (default limit: 100)
const all = await client.crud("candidate").list();

// Filter + embed relations
const screened = await client.crud("candidate").list({
  filters: { stage: "screening" },
  include: ["posting"],
  limit: 50,
  offset: 0,
});

// Get one record by UUID
const c = await client.crud("candidate").get("uuid-here");

// Get one with embedded relations
const cFull = await client.crud("candidate").get("uuid-here", {
  include: ["posting", "assessments"],
});

// Create
const created = await client.crud<CandidateRead, CandidateCreate>("candidate")
  .create({ name: "Alice", email: "alice@example.com", stage: "applied" });

// Partial update (PATCH — only the fields you pass are changed)
const updated = await client.crud("candidate").update("uuid", { stage: "interview" });

// Delete (resolves void on HTTP 204)
await client.crud("candidate").delete("uuid");
```

### `client.crud<TRead, TCreate, TUpdate>(modelName)`

Returns a `CrudClient<TRead, TCreate, TUpdate>` instance. All type parameters default to `unknown` / `Partial<TRead>`. The model name is lowercased automatically. A refused call rejects with `TuvlApiError`.

### `CrudListOptions`

| Option | Type | Description |
|---|---|---|
| `limit` | `number` | Max records to return (server default: 100, max: 1000) |
| `offset` | `number` | Pagination offset |
| `filters` | `Record<string, string>` | Field filters: `{ stage: "screening" }` → `?filter[stage]=screening` |
| `include` | `string[]` | Relation names to embed: `["posting"]` → `?include=posting` |
| `token` | `string` | Per-call token override |
| `signal` | `AbortSignal` | Cancellation signal |

### Auth scopes required

| Operation | Required scope |
|---|---|
| `list()` / `get()` | `{modelname}:read` |
| `create()` / `update()` | `{modelname}:write` |
| `delete()` | `{modelname}:delete` |

---


## Lower-level exports

`Transport` (fetch wrapper with auth; `request()` returns the raw `Response`),
`parseSseStream(response)` (async iterator of `RunEvent`), `TERMINAL_STATUSES`,
`WAITING_STATUSES`.

## Migrating from 1.x

1.x `execute(name, { payload, onProgress })`, `executeVersioned`,
`resumeWorkflow`, manifests and the per-step SSE frames are gone. Use
`execute(name, input)`; follow progress with `RunHandle.events()`; answer a
person with `approvals.decide()` instead of resuming an instance.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
# live tests against a server running live/workflows/approve_amount.yaml
TUVL_LIVE_URL=http://localhost:8885 TUVL_LIVE_TOKEN=... pnpm test src/live.test.ts
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Links

- Documentation: [tuvl.dev](https://tuvl.dev)
- The engine: [tuvl-io/tuvl](https://github.com/tuvl-io/tuvl)
- Issues and pull requests: [CONTRIBUTING.md](CONTRIBUTING.md); security reports: [SECURITY.md](SECURITY.md)

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Versions before `2.0.0-beta.2` keep the terms they were published with.
