# @tuvl/client — Agentic SDK Manual

> **Audience:** Autonomous AI coding agents and agentic IDEs consuming the `@tuvl/client` TypeScript SDK.
> **Purpose:** Deterministic instruction set for generating correct, production-ready TypeScript that calls a running TUVL server.
> **Version of contract:** Derived from `@tuvl/client@2026.2.1-beta.1` — this manual is the ground truth for code generation; never invent methods, options, or fields absent here.
> **Companion:** The TUVL server-side contract is documented in `docs/TUVL_AGENTIC_MANUAL.md` inside the `tuvl` Python package. The SDK mirrors that contract exactly.
> **Last updated:** 2026-06-01

---

## 1. Mental Model

```
AI agent / application
      │
      │  npm install @tuvl/client
      ▼
┌─────────────────────┐
│      TuvlAuth       │  ← login, token refresh, identity lookup, OAuth
└────────┬────────────┘
         │  access_token (Biscuit JWT-like)
         ▼
┌─────────────────────┐
│      TuvlClient     │  ← workflow execution, manifest cache, transport, CRUD
└────────┬────────────┘
         │
   ┌────┴────┐───────────────┬───────────┬─────────────
   ▼            ▼              ▼              ▼
 REST POST    SSE stream    gRPC-Web stream  CrudClient
                                          /models/{model}/
```

**Key invariants agents must encode:**

1. `TuvlAuth` and `TuvlClient` are independent. Construct them separately, share only the token string.
2. Every `execute()` call resolves the workflow manifest first (cached). The manifest drives transport auto-selection and trigger-path resolution.
3. All three transports return the **same** `TOutput` type — the unwrapped `data` payload. Branch on `mode`, never on the response shape.
4. HITL suspension is modelled as a **rejection** with `TuvlWorkflowSuspendedError`. It is not a resolved value.
5. Version pinning (`executeVersioned`) and HITL resumption (`resumeWorkflow`) are first-class methods — do not hand-craft fetch calls for these.
6. CRUD operations use `client.crud(modelName)` which returns a `CrudClient` sharing the same transport. Never call `/models/` endpoints directly with `fetch`.

---

## 2. Installation

```bash
npm install @tuvl/client
# or
pnpm add @tuvl/client
```

**gRPC-Web peer dependencies** — only needed when `mode: "grpc"`:

```bash
npm install @protobuf-ts/grpcweb-transport @protobuf-ts/runtime-rpc
```

---

## 3. Module Contract

### 3.1 Named exports

| Export | Kind | Purpose |
|---|---|---|
| `TuvlAuth` | class | Auth endpoints (`/auth/*`) |
| `TuvlClient` | class | Workflow execution and CRUD factory |
| `CrudClient` | class | Typed CRUD access to `/models/{model}/` |
| `TuvlWorkflowError` | class | Business failure rejection value |
| `TuvlWorkflowSuspendedError` | class | HITL suspension rejection value |
| `Transport` | class | Raw HTTP layer (advanced) |
| `parseSseStream` | async generator | SSE frame parser (advanced) |
| `openGrpcStream` | async generator | gRPC-Web stream (advanced) |

### 3.2 Named type exports

```ts
import type {
  // Auth
  TokenResponse,          // { access_token: string; token_type: string }
  MeResponse,             // { user_id, groups, scopes }
  // Execution events (SSE / gRPC)
  StepEvent,              // { event_type:"step", step_id, kind, signal, snapshot, duration_ms }
  DoneEvent,              // { event_type:"done", success, data, error }
  ErrorEvent,             // { event_type:"error", message, details }
  SuspendedEvent,         // { event_type:"suspended", instance_id, ui, schema, context_data, … }
  // REST envelope
  RestEnvelope,           // { success, data, error }
  WorkflowErrorPayload,   // { code?, message?, details?, … }
  // Manifests
  WorkflowManifest,       // server manifest shape for one workflow
  WorkflowManifestMap,    // record of manifests from listWorkflows()
  // Workflow options
  TuvlClientOptions,      // constructor options
  ExecuteOptions,         // options for execute()
  ExecuteVersionedOptions,// options for executeVersioned()
  ResumeOptions,          // options for resumeWorkflow()
  ResumeRequest,          // raw body sent to POST /api/workflows/resume
  // CRUD options
  CrudListOptions,        // options for CrudClient.list()
  CrudGetOptions,         // options for CrudClient.get()
  CrudMutateOptions,      // options for CrudClient.create() / update() / delete()
} from "@tuvl/client";
```

### 3.3 Module format

| Environment | File served |
|---|---|
| ESM (`import`) | `dist/index.mjs` |
| CJS (`require`) | `dist/index.js` |
| TypeScript / bundler | `dist/index.d.ts` / `dist/index.d.mts` |

### 3.4 Dev toolchain

The SDK is built and tested with the following toolchain. Agents generating contributions, CI config, or Dockerfile instructions must target these exact versions.

| Tool | Version | Role |
|---|---|---|
| TypeScript | `^6.0.0` (6.0.3) | Type checking + DTS generation |
| tsup | `^8.1.0` (8.5.1) | Dual ESM + CJS bundler (esbuild-based) |
| vite | `^8.0.0` (8.0.16) | Peer required by vitest 4 |
| vitest | `^4.0.0` (4.1.8) | Unit test runner |
| Node.js | 22 | Runtime for CI and local dev |
| pnpm | 10 | Package manager (lockfile is pnpm format) |

**Key config files:**

| File | Purpose |
|---|---|
| `tsconfig.json` | `target: ES2020`, `module: ESNext`, `moduleResolution: bundler`, `ignoreDeprecations: "6.0"` |
| `tsup.config.mts` | `entry: ["src/index.ts"]`, `format: ["esm", "cjs"]`, `dts: true`, `target: es2020` |
| `vitest.config.mts` | `environment: node`, `globals: true`, `include: ["src/**/*.test.ts"]` |

> **Note on `.mts` config files:** Both `tsup.config.mts` and `vitest.config.mts` use the `.mts` extension (not `.ts`). This forces Node.js to load them as ES modules, which in turn makes Vite load its ESM entry point instead of the deprecated CJS Node API. Do **not** rename these to `.ts`.

---

## 4. Authentication — `TuvlAuth`

### 4.1 Constructor

```ts
import { TuvlAuth } from "@tuvl/client";

const auth = new TuvlAuth({ baseUrl: "http://localhost:8000" });
```

| Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | tuvl server URL — trailing slash is stripped automatically |

### 4.2 Methods

#### `auth.bootstrap(params)`

One-time IAM initialisation. Creates the superadmin. **Rejects with HTTP 409 on every subsequent call.**

```ts
const { access_token } = await auth.bootstrap({
  email: "admin@example.com",
  password: "change-me-now",
  admin_scope: "iam:admin",
});
```

#### `auth.loginWithPassword(email, password)`

Form-encoded `POST /auth/token`. Returns `TokenResponse`.

```ts
const { access_token } = await auth.loginWithPassword("me@example.com", "secret");
```

#### `auth.getMe(token)`

Decodes the Biscuit token server-side and returns `MeResponse` (user UUID, groups, scopes). Use this to gate UI features or decide which workflow scope to request.

```ts
const me = await auth.getMe(access_token);
// me.user_id — UUID string
// me.groups  — e.g. ["hr_manager", "member"]
// me.scopes  — e.g. ["candidate:read", "candidate:write"]

if (me.groups.includes("hr_manager")) { /* show HR panel */ }
if (me.scopes.includes("iam:admin"))  { /* show admin panel */ }
```

#### `auth.getOAuthLoginUrl(provider)`

Returns the browser redirect URL for OAuth2 social login. Redirect the browser to this URL.

```ts
// provider: "google" | "github" | "microsoft" | any registered FederationProvider name
window.location.href = auth.getOAuthLoginUrl("google");

// On the callback page (TUVL_OAUTH_UI_REDIRECT_URL), read the token:
const token = new URLSearchParams(window.location.search).get("token")!;
```

#### `auth.refresh(token)`

Rotates the token. Always replace the stored token with the result.

```ts
const { access_token: newToken } = await auth.refresh(currentToken);
client.setToken(newToken);
```

#### `auth.logout(token)`

Invalidates the token server-side. Delete the stored token after this resolves.

```ts
await auth.logout(token);
localStorage.removeItem("tuvl_token");
```

---

## 5. Workflow Execution — `TuvlClient`

### 5.1 Constructor

```ts
import { TuvlClient } from "@tuvl/client";

const client = new TuvlClient({
  baseUrl: "http://localhost:8000",
  token: access_token,         // optional — set per-call with options.token if preferred
  manifestCacheTtl: 60_000,    // optional — default 60 000 ms; 0 disables caching
});
```

### 5.2 `client.execute(workflowName, options?)`

Runs a workflow by **name** against its active default trigger path. Returns `Promise<TOutput>` — the unwrapped `data` payload, identical across all transports.

```ts
const result = await client.execute<MyOutputType>("my-workflow", {
  payload: { key: "value" },        // matches the workflow's input_schema
  onProgress: (ev) => { ... },      // StepEvent — triggers SSE auto-upgrade
  onSuspended: (ev) => { ... },     // SuspendedEvent — fires, then promise rejects
  mode: "sse",                      // force transport (omit for auto)
  token: "...",                     // per-call token override
  signal: abortController.signal,   // cancellation
});
```

#### Transport auto-selection logic

| Condition | Transport used |
|---|---|
| `mode: "grpc"` | gRPC-Web |
| `mode: "sse"` | SSE |
| `mode: "rest"` | Plain JSON POST |
| `onProgress` provided **and** `manifest.has_slow_steps === true` | SSE (auto) |
| Default (no mode, no progress handler) | Plain JSON POST |

Agents should **not** force a transport unless the use-case requires it. Pass `onProgress` and let the SDK decide.

#### Return-value contract

| Server outcome | `execute()` resolves/rejects |
|---|---|
| `success: true` | **Resolves** with `data` (the workflow output) |
| `success: false` | **Rejects** with `TuvlWorkflowError` — carries `.data` (partial) and `.error` (structured) |
| HITL suspension | **Rejects** with `TuvlWorkflowSuspendedError` — carries `.suspended` (the `SuspendedEvent`) |
| Engine exception | **Rejects** with plain `Error` |
| Transport / network failure | **Rejects** with plain `Error` |

```ts
import { TuvlClient, TuvlWorkflowError, TuvlWorkflowSuspendedError } from "@tuvl/client";

try {
  const result = await client.execute<Candidate>("screen-candidate", {
    payload: { candidate_id: 42 },
    onProgress: (ev) => console.log(`[${ev.step_id}] ${ev.duration_ms}ms`),
    onSuspended: (ev) => queueHitlTask(ev),
  });
  // result is fully-typed TOutput
} catch (err) {
  if (err instanceof TuvlWorkflowSuspendedError) {
    // err.suspended — full SuspendedEvent
    // err.suspended.instance_id — needed for resumeWorkflow()
  } else if (err instanceof TuvlWorkflowError) {
    // err.data  — partial workflow context snapshot
    // err.error — WorkflowErrorPayload { code, message, details }
  } else {
    throw err; // re-throw transport / unknown errors
  }
}
```

### 5.3 `client.executeVersioned(workflowName, version, options?)`

Runs a workflow pinned to an **explicit schema version**, calling `POST /{version}/run/{workflowName}` on the server. Accepts the same options as `execute()`.

Use this when:
- Multiple versions of a workflow coexist and the caller must stay on a specific contract.
- The workflow has no `trigger.path` defined (internal workflows reachable only via the versioned route).
- A/B traffic splitting between v1 and v2.

```ts
// Pin to "v2" even if "v3" is the active default trigger
const result = await client.executeVersioned<MyOutput>("onboard-candidate", "v2", {
  payload: { name: "Alice", email: "alice@example.com" },
  onProgress: (ev) => console.log(ev.step_id),
});
```

The SDK best-effort fetches the manifest for SSE auto-selection and falls through to REST if the manifest is unavailable. The `version` string must **exactly** match `metadata.schema_version` in the TUVL YAML.

### 5.4 `client.resumeWorkflow(options)` — HITL resumption

Resumes a workflow instance that was paused at a `HumanInTheLoop` step.

```ts
import { TuvlWorkflowSuspendedError, type SuspendedEvent } from "@tuvl/client";

// Step 1 — initial execution; catch the suspension
let suspended: SuspendedEvent | undefined;
try {
  await client.execute("hire-candidate", {
    payload: { candidate_id: 99 },
    onSuspended: (ev) => { suspended = ev; },
  });
} catch (err) {
  if (!(err instanceof TuvlWorkflowSuspendedError)) throw err;
  suspended = err.suspended;
}

// Step 2 — human fills in the HITL form (built from suspended.ui / suspended.schema)
const humanDecision = { approved: true, note: "Strong cultural fit" };

// Step 3 — resume
const finalResult = await client.resumeWorkflow<HireOutput>({
  instanceId: suspended!.instance_id!,
  humanInput: humanDecision,
  onProgress: (ev) => console.log(`[resumed] ${ev.step_id}`),
  // mode: "sse" is auto-selected when onProgress is provided
});
```

| Option | Type | Description |
|---|---|---|
| `instanceId` | `string` | UUID from `SuspendedEvent.instance_id` |
| `humanInput` | `Record<string, unknown>` | Operator-supplied form data. Merged into workflow context at the paused step. |
| `onProgress` | `(event: StepEvent) => void` | Step events for steps after the resume point. Auto-selects SSE. |
| `onSuspended` | `(event: SuspendedEvent) => void` | Fires if the workflow suspends again at a second HITL step. |
| `mode` | `"rest" \| "sse"` | Force transport (default: REST; SSE when `onProgress` is provided). gRPC not supported for resume. |
| `token` | `string` | Per-call token override |
| `signal` | `AbortSignal` | Cancellation signal |

The server endpoint is `POST /api/workflows/resume` with body `{ instance_id, human_input }`.

---

## 6. Utility Methods

### `client.getManifest(workflowName, options?)`

Fetches (and caches) the workflow manifest from `GET /api/_system/workflows/{name}`. Called automatically by `execute()` and `executeVersioned()`. Call directly only if you need `WorkflowManifest` fields (e.g. `trigger_path`, `has_slow_steps`, `required_scope`) without executing.

```ts
const manifest = await client.getManifest("screen-candidate");
// manifest.trigger_path    — HTTP path
// manifest.has_slow_steps  — whether SSE auto-upgrade would fire
// manifest.required_scope  — Biscuit scope guard (informational, enforced server-side)
```

### `client.listWorkflows()`

Returns `WorkflowManifestMap` — a record of all registered, enabled workflows. Use this to render a discovery UI or validate that a workflow name exists before calling.

```ts
const workflows = await client.listWorkflows();
// { "screen-candidate": { trigger_path, has_slow_steps, … }, … }
```

### `client.setToken(token)`

Replaces the default token on the client instance in-place. Call after `auth.refresh()`.

```ts
const { access_token: newToken } = await auth.refresh(currentToken);
client.setToken(newToken);
```

### `client.invalidateManifest(name?)`

Clears the manifest cache. Pass a name to invalidate one entry; omit to clear all. Call after a server deployment that may change workflow routing.

```ts
client.invalidateManifest("screen-candidate"); // one entry
client.invalidateManifest();                   // all
```

---

## 7. CRUD — Model Data Access

`client.crud(modelName)` returns a `CrudClient` targeting the tuvl model endpoints at `/models/{modelname}/`. It shares the same `Transport` (base URL + auth token) as the parent `TuvlClient`.

### 7.1 Method signatures

```ts
crud<TRead = unknown, TCreate = Partial<TRead>, TUpdate = Partial<TRead>>(
  modelName: string
): CrudClient<TRead, TCreate, TUpdate>
```

### 7.2 `CrudClient` methods

| Method | HTTP | Path | Returns |
|---|---|---|---|
| `list(options?)` | GET | `/models/{model}/` | `Promise<TRead[]>` |
| `get(id, options?)` | GET | `/models/{model}/{id}` | `Promise<TRead>` |
| `create(body, options?)` | POST | `/models/{model}/` | `Promise<TRead>` |
| `update(id, body, options?)` | PATCH | `/models/{model}/{id}` | `Promise<TRead>` |
| `delete(id, options?)` | DELETE | `/models/{model}/{id}` | `Promise<void>` |

### 7.3 `CrudListOptions` wire encoding

| Field | Type | Query param emitted |
|---|---|---|
| `limit` | `number` | `?limit=N` |
| `offset` | `number` | `?offset=N` |
| `filters` | `Record<string, string>` | `?filter[key]=value` (bracket notation) |
| `include` | `string[]` | `?include=rel1,rel2` (comma-joined) |
| `token` | `string` | — (Authorization header) |
| `signal` | `AbortSignal` | — (fetch cancellation) |

### 7.4 Canonical CRUD pattern

```ts
import { TuvlClient, type CrudListOptions } from "@tuvl/client";

interface CandidateRead  { id: string; name: string; stage: string; email: string }
interface CandidateCreate { name: string; email: string; stage?: string }
interface CandidateUpdate { stage?: string; note?: string }

const client = new TuvlClient({ baseUrl: BASE_URL, token });

// List with filters + pagination
const opts: CrudListOptions = {
  filters: { stage: "screening" },
  include: ["posting"],
  limit: 50,
};
const candidates = await client.crud<CandidateRead>("candidate").list(opts);

// Get one
const c = await client.crud<CandidateRead>("candidate").get(candidateId);

// Get one with relations
const cFull = await client.crud<CandidateRead>("candidate").get(candidateId, {
  include: ["posting", "assessments"],
});

// Create
const created = await client
  .crud<CandidateRead, CandidateCreate>("candidate")
  .create({ name: "Alice", email: "alice@example.com" });

// Partial update
const updated = await client
  .crud<CandidateRead, CandidateCreate, CandidateUpdate>("candidate")
  .update(created.id, { stage: "interview" });

// Delete
await client.crud("candidate").delete(updated.id);
```

### 7.5 Auth scopes

CRUD endpoints enforce Biscuit scopes derived from the model name:

| Operation | Required scope |
|---|---|
| `list()` / `get()` | `{modelname}:read` |
| `create()` / `update()` | `{modelname}:write` |
| `delete()` | `{modelname}:delete` |

Check `me.scopes` from `auth.getMe(token)` before rendering CRUD UI. **Scope enforcement is server-side** — the SDK will throw on HTTP 403, not silently suppress the call.

### 7.6 Error behaviour

All `CrudClient` methods throw a plain `Error` on non-2xx responses. The message includes the HTTP status and body text:

```
tuvl GET /models/candidate/abc → HTTP 404: Candidate 'abc' not found
```

CRUD calls do **not** throw `TuvlWorkflowError` or `TuvlWorkflowSuspendedError` — those are workflow-only rejection types. Wrap CRUD calls in a plain `try/catch`.

---

## 8. SuspendedEvent Shape

When a workflow hits a `HumanInTheLoop` step the server emits a `SuspendedEvent`. Agents should persist or relay this object as-is — it contains everything needed to render the HITL form.

```ts
interface SuspendedEvent {
  event_type: "suspended";
  instance_id?: string;         // UUID — pass to resumeWorkflow({ instanceId })
  paused_step_id?: string;      // step id from the YAML
  ui?: {                        // rendering hints (set by HumanInTheLoop.ui in YAML)
    title?: string;
    instruction?: string;
    display_context?: Record<string, unknown>;
  };
  schema?: Array<{              // form field descriptors
    name: string;
    type: "boolean" | "string" | "integer" | "float";
    required?: boolean;
    label?: string;
  }>;
  context_data?: Record<string, unknown>; // allowlisted context keys
  output_key?: string;          // context key where human_input will land
  [key: string]: unknown;       // server may attach extra fields
}
```

---

## 9. Error Classes

Both error classes are real JavaScript classes — safe to use with `instanceof`.

### `TuvlWorkflowError`

Thrown when the workflow engine completes but signals business failure (`success: false`).

```ts
import { TuvlWorkflowError } from "@tuvl/client";

try {
  await client.execute("validate-invoice", { payload: { amount: -1 } });
} catch (err) {
  if (err instanceof TuvlWorkflowError) {
    console.error(err.error?.code);    // e.g. "VALIDATION_FAILED"
    console.error(err.error?.message); // human-readable reason
    console.log(err.data);             // partial workflow context snapshot
  }
}
```

| Property | Type | Description |
|---|---|---|
| `message` | `string` | Error message string (standard `Error`) |
| `data` | `unknown` | Partial workflow context snapshot at failure time |
| `error` | `WorkflowErrorPayload \| null` | Structured error from the engine |

### `TuvlWorkflowSuspendedError`

Thrown when a `HumanInTheLoop` step suspends the workflow.

```ts
import { TuvlWorkflowSuspendedError } from "@tuvl/client";

try {
  await client.execute("approve-leave");
} catch (err) {
  if (err instanceof TuvlWorkflowSuspendedError) {
    const { instance_id, ui, schema } = err.suspended;
    renderHitlForm({ instance_id, ui, schema });
  }
}
```

| Property | Type | Description |
|---|---|---|
| `message` | `string` | Error message string (standard `Error`) |
| `suspended` | `SuspendedEvent` | Full suspension event from the server |

---

## 10. Advanced — Lower-Level Exports

Use the building blocks directly only for non-standard transports or custom streaming logic.

### `Transport`

```ts
import { Transport } from "@tuvl/client";

const transport = new Transport({ baseUrl: "...", token: "..." });

// POST with JSON body, returns parsed response
const data = await transport.post<ReqBody, ResBody>("/api/some-endpoint", body, { token });

// POST that returns a ReadableStream for manual SSE / NDJSON parsing
const stream = await transport.postStream("/api/sse-endpoint", body, { token });

// GET with parsed response
const result = await transport.get<Res>("/api/some-endpoint", { token });
```

### `parseSseStream`

```ts
import { parseSseStream } from "@tuvl/client";

for await (const frame of parseSseStream(response, signal)) {
  // frame is StepEvent | DoneEvent | ErrorEvent | SuspendedEvent
  // (the event_type discriminator is injected from the SSE `event:` line)
}
```

### `openGrpcStream`

```ts
import { openGrpcStream } from "@tuvl/client";

// Requires @protobuf-ts/grpcweb-transport to be installed
for await (const event of openGrpcStream({
  baseUrl: "http://localhost:8000",
  workflowName: "my-workflow",
  payloadJson: JSON.stringify(payload),
  token,
  signal,
})) { /* … */ }
```

---

## 11. Golden Rules for AI Code Generation

These are **hard constraints**. Violating any produces incorrect or unsafe TypeScript.

1. **Never invent methods on `TuvlClient` or `TuvlAuth`.** The full public API is: `execute`, `executeVersioned`, `resumeWorkflow`, `getManifest`, `listWorkflows`, `setToken`, `invalidateManifest`, `crud` on the client; `bootstrap`, `loginWithPassword`, `getMe`, `getOAuthLoginUrl`, `refresh`, `logout` on auth.
2. **Always wrap `execute()` / `executeVersioned()` / `resumeWorkflow()` in try/catch.** These are async and reject on workflow failure, HITL suspension, and transport errors. Never leave them uncaught.
3. **Always check `instanceof TuvlWorkflowSuspendedError` before `instanceof TuvlWorkflowError`.** `SuspendedError` does not extend `WorkflowError`; both extend `Error`. Check the more specific type first.
4. **Never access `err.suspended` without confirming `instanceof TuvlWorkflowSuspendedError`.** Same for `err.data` / `err.error` without `instanceof TuvlWorkflowError`.
5. **Never pass the raw `SuspendedEvent` as `humanInput`.** `humanInput` is the operator-supplied form data; `SuspendedEvent` is the metadata about the paused step. They are different objects.
6. **Pass `instanceId` (camelCase), not `instance_id` (snake_case), to `resumeWorkflow()`.** The SDK translates to the server's snake_case wire format internally.
7. **Do not duplicate context data into the `payload`.** The server reads from the `payload` dict and places it into `context`; sending the same field twice does not merge — it overwrites based on step execution order.
8. **Use `client.setToken(newToken)` after `auth.refresh()`.** The old token on the client instance does not auto-expire.
9. **Do not pass `mode: "grpc"` to `resumeWorkflow()`.** gRPC-Web is not supported for the resume endpoint. Only `"rest"` (default) and `"sse"` are valid.
10. **Only call `openGrpcStream` if `@protobuf-ts/grpcweb-transport` is in `node_modules`.** It is a peer dependency, not a hard dependency. Calling it without the peer installed throws a dynamic import error at runtime, not at build time.
11. **Treat `SuspendedEvent` fields as optional.** The server may not populate every field on every HITL configuration. Always use optional chaining (`ev.instance_id?.`).
12. **Use `AbortSignal` for cancellable workflows.** Long-running SSE or gRPC streams do not self-cancel on navigation. Pass `abortController.signal` and call `controller.abort()` on cleanup (e.g. React `useEffect` return).
13. **Do not hardcode `baseUrl`.** Read it from environment configuration (`process.env.TUVL_BASE_URL`, `import.meta.env.VITE_TUVL_BASE_URL`, etc.). Never embed production server URLs in source code.
14. **Do not log `access_token` values.** Biscuit tokens are opaque bearer credentials. Call `auth.getMe(token)` when you need user identity data — never decode or parse the token string directly.
15. **Use `ExecuteVersionedOptions` (not `ExecuteOptions`) for `executeVersioned()` calls.** While `ExecuteVersionedOptions` extends `ExecuteOptions`, using the correct type makes the `version` field explicit and prevents type-widening mistakes.
16. **Config files must remain `.mts`, not `.ts`.** `tsup.config.mts` and `vitest.config.mts` use `.mts` to force ESM loading. Renaming them to `.ts` re-introduces the Vite CJS Node API deprecation warning and will break CI.
17. **`"ignoreDeprecations": "6.0"` in `tsconfig.json` is intentional.** It suppresses a TypeScript 6 error caused by tsup's DTS builder passing the deprecated `baseUrl` option internally. Do not remove it until tsup 9+ ships with a TS 6-compatible DTS pipeline.
18. **Use `client.crud(modelName)` for all model data access.** Never hand-craft `fetch` calls to `/models/`. The `CrudClient` handles URL encoding, query param serialisation, auth injection, and error wrapping consistently.
19. **Never throw `TuvlWorkflowError` / `TuvlWorkflowSuspendedError` from CRUD error paths.** `CrudClient` throws plain `Error` instances. Do not catch CRUD errors with `instanceof TuvlWorkflowError`.
20. **Pass `filters` as `Record<string, string>` (not query string).** The SDK serialises `{ stage: "screening" }` to `?filter[stage]=screening` internally. Never manually append filter params to the model name string.

---

## 12. Canonical Integration Pattern (end-to-end)

```ts
import {
  TuvlAuth,
  TuvlClient,
  TuvlWorkflowError,
  TuvlWorkflowSuspendedError,
  type SuspendedEvent,
} from "@tuvl/client";

// ── 1. Setup ────────────────────────────────────────────────────────────────

const BASE_URL = process.env.TUVL_BASE_URL!;
const auth = new TuvlAuth({ baseUrl: BASE_URL });
const client = new TuvlClient({ baseUrl: BASE_URL });

// ── 2. Login ─────────────────────────────────────────────────────────────────

const { access_token } = await auth.loginWithPassword("hr@example.com", "secret");
client.setToken(access_token);

// ── 3. Check identity ────────────────────────────────────────────────────────

const me = await auth.getMe(access_token);
if (!me.scopes.includes("candidate:write")) {
  throw new Error("Insufficient permissions");
}

// ── 4. Execute a workflow ─────────────────────────────────────────────────────

interface OnboardResult { id: string; score: number }

let suspended: SuspendedEvent | undefined;

try {
  const result = await client.execute<OnboardResult>("onboard-candidate", {
    payload: { name: "Alice", email: "alice@example.com", cv: "..." },
    onProgress: (ev) => console.log(`[${ev.step_id}] ${ev.kind} — ${ev.duration_ms}ms`),
    onSuspended: (ev) => { suspended = ev; },
  });
  console.log("Onboarded:", result.id, "score:", result.score);

} catch (err) {
  if (err instanceof TuvlWorkflowSuspendedError) {
    suspended = err.suspended;
    // fall through to HITL handling below
  } else if (err instanceof TuvlWorkflowError) {
    console.error("Workflow failed:", err.error?.message, err.data);
    process.exit(1);
  } else {
    throw err;
  }
}

// ── 5. HITL resumption (if the workflow paused) ───────────────────────────────

if (suspended) {
  // render suspended.ui, suspended.schema to the operator …
  const humanDecision = { approved: true, note: "Looks great" };

  const finalResult = await client.resumeWorkflow<OnboardResult>({
    instanceId: suspended.instance_id!,
    humanInput: humanDecision,
    onProgress: (ev) => console.log(`[resumed] ${ev.step_id}`),
  });
  console.log("Resumed and finished:", finalResult);
}

// ── 6. Versioned execution ────────────────────────────────────────────────────

// Always call the v2 contract, even if a newer version is active
const v2Result = await client.executeVersioned<OnboardResult>(
  "onboard-candidate",
  "v2",
  { payload: { name: "Bob", email: "bob@example.com" } },
);

// ── 7. Token refresh ─────────────────────────────────────────────────────────

const { access_token: refreshed } = await auth.refresh(access_token);
client.setToken(refreshed);
```

---

## 13. Quick Reference — Generation Decision Tree

```
Need to …
├── Authenticate a user                    → auth.loginWithPassword() or auth.getOAuthLoginUrl()
├── One-time admin setup                   → auth.bootstrap()
├── Check user roles / scopes in code      → auth.getMe(token)
├── Run a workflow (any transport)         → client.execute(name, { payload, onProgress })
├── Run a workflow at a specific version   → client.executeVersioned(name, version, options)
├── Handle HITL suspension                 → catch TuvlWorkflowSuspendedError, then resumeWorkflow()
├── Resume a suspended workflow            → client.resumeWorkflow({ instanceId, humanInput })
├── Handle workflow business failure       → catch TuvlWorkflowError (.error, .data)
├── Read all records for a model           → client.crud("model").list()
├── Filter / paginate model records        → client.crud("model").list({ filters, limit, offset })
├── Embed related records                  → client.crud("model").list/get({ include: ["rel"] })
├── Get a single record by UUID            → client.crud("model").get(id)
├── Create a new record                    → client.crud("model").create(body)
├── Partially update a record              → client.crud("model").update(id, patch)
├── Delete a record                        → client.crud("model").delete(id)
├── List all available workflows           → client.listWorkflows()
├── Inspect workflow trigger / hints       → client.getManifest(name)
├── Rotate auth token                      → auth.refresh(token) → client.setToken(newToken)
├── Invalidate cached manifest             → client.invalidateManifest(name?)
├── Cancel a long-running stream           → pass AbortSignal, call controller.abort()
└── Raw HTTP access beyond the SDK API     → new Transport({ baseUrl, token }).post / .get
```

End of manual.

---

## Appendix A — Test Suite

The SDK ships with a full unit test suite (`vitest 4`, `environment: node`, no real network calls — all fetch calls are stubbed).

| File | Tests | What is covered |
|---|---|---|
| `src/types.test.ts` | 6 | `TuvlWorkflowError` and `TuvlWorkflowSuspendedError` — construction, `.name`, `.data`, `.error`, `.suspended` |
| `src/transport.test.ts` | 11 | `Transport.post/get/patch/delete/postStream/setToken` — auth header injection, error status handling, baseUrl normalisation |
| `src/auth.test.ts` | 13 | All `TuvlAuth` methods — success + HTTP error paths, form-encoding, URL encoding, 204 logout |
| `src/sse.test.ts` | 10 | `parseSseStream` — step/done/error/suspended frames, CRLF, non-JSON skip, terminal-frame stop, abort signal |
| `src/crud.test.ts` | 19 | `CrudClient.list/get/create/update/delete` — query param serialisation (filters, include, pagination), auth header, HTTP method, error paths, `TuvlClient.crud()` factory |
| `src/client.test.ts` | 21 | `TuvlClient` REST/SSE execute, SSE auto-upgrade, error/suspended/engine-error rejection, manifest cache/invalidation, `executeVersioned`, `resumeWorkflow`, `setToken` |

Run with:

```bash
pnpm test          # single run
pnpm test:watch    # watch mode
```

All tests run in Node 22, use `vi.stubGlobal("fetch", mockFetch)` for fetch stubbing, and are reset in `beforeEach`. No integration server is required.

---

## Appendix B — Changelog

### 2026-06-01

- **Toolchain upgrade:** vitest `1.6.1` → `4.1.8`; TypeScript `5.9.3` → `6.0.3`; `@types/node` `20` → `25`; added `vite@^8.0.0` as explicit dev dep (required peer of vitest 4).
- **Config files renamed to `.mts`:** `tsup.config.ts` and `vitest.config.ts` → `.mts`. Fixes the "CJS build of Vite's Node API is deprecated" CI warning by forcing ESM config loading.
- **`ignoreDeprecations: "6.0"` added to `tsconfig.json`:** Suppresses TS 6 error from tsup's internal `baseUrl` usage during DTS generation.
- **CI updated:** `pnpm/action-setup@v3` → `@v4` (pnpm 10); `node-version: "20"` → `"22"`.
- **Test suite added:** 61 unit tests across 5 files covering all SDK modules (see Appendix A).
- **`--passWithNoTests` flag added to `pnpm test`:** Prevents CI exit-code 1 on repositories with no test files yet.
