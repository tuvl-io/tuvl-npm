# @tuvl/client

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

**2.0 public beta** (until 2.0.0 on 20 October): `npm install @tuvl/client@beta` installs
`2.0.0-beta.1`, which talks to a tuvl `2.0.0b1` server (`uv tool install tuvl==2.0.0b1`).
The plain install above stays on 1.x until then.

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

### `RunHandle`

| Member | |
|---|---|
| `id`, `run` | run id; the run as last seen |
| `get()` | refresh (`GET /api/runs/{id}`) |
| `events({ fromSeq?, follow? })` | async iterator of `RunEvent` over SSE: replay, then live until the run ends |
| `wait({ intervalMs?, timeoutMs?, untilWaiting? })` | poll until the run ends; resolves the output or rejects `TuvlRunError`. `untilWaiting` also stops when it waits on a person |
| `pause()`, `resume()`, `abort()`, `steer(message)` | operator control (scope `runs:control`) |

`client.run(id)` gives a handle on any run.

### `client.runs`

`list({ workflow?, status?, limit? })`, `get(id)`, `events(id, opts)`,
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

The `TuvlAuth` class wraps the most common `/auth/*` endpoints — `bootstrap`, `loginWithPassword`, `getOAuthLoginUrl`, `getMe`, `refresh`, `logout` — so you don't have to hand-craft form bodies or Biscuit decoding logic. Admin endpoints (user / role / scope CRUD, federation config) are intentionally not wrapped; call them directly with `fetch` or the lower-level `Transport` using the same Bearer token.

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

### Get current user identity and roles

Biscuit tokens are protobuf-encoded and cannot be decoded in pure JS. Use `getMe()` to ask the server to decode the token and return the user's identity, group memberships, and permission scopes:

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

Returns a `CrudClient<TRead, TCreate, TUpdate>` instance. All type parameters default to `unknown` / `Partial<TRead>`. The model name is lowercased automatically.

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
pnpm typecheck && pnpm test && pnpm build
# live tests against a server running live/workflows/approve_amount.yaml
TUVL_LIVE_URL=http://localhost:8885 TUVL_LIVE_TOKEN=... pnpm test src/live.test.ts
```
