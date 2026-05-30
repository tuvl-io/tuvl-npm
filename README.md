# @tuvl/client

TypeScript client SDK for the [tuvl](https://tuvl.io) workflow orchestration engine.

Supports three transports from a single `execute()` call — plain REST, Server-Sent Events, and gRPC-Web — with automatic transport selection based on the workflow's streaming hints.

---

## Installation

```bash
npm install @tuvl/client
# or
pnpm add @tuvl/client
# or
yarn add @tuvl/client
```

**gRPC-Web** is optional. Install the peer dependencies only if you need `mode: "grpc"`:

```bash
npm install @protobuf-ts/grpcweb-transport @protobuf-ts/runtime-rpc
```

---

## Quick start

```ts
import { TuvlAuth, TuvlClient } from "@tuvl/client";

// 1. Login
const auth = new TuvlAuth({ baseUrl: "http://localhost:8000" });
const { access_token } = await auth.loginWithPassword("me@example.com", "secret");

// 2. Who am I? (roles + scopes without touching Biscuit internals)
const me = await auth.getMe(access_token);
console.log(me.groups);  // ["hr_manager"]
console.log(me.scopes);  // ["candidate:read", "requisition:write"]

// 3. Run a workflow
const client = new TuvlClient({ baseUrl: "http://localhost:8000", token: access_token });

// Plain REST call
const result = await client.execute("hello", {
  payload: { message: "world" },
});

// SSE streaming — auto-detected when onProgress is provided
// and the workflow has slow steps (agent / mcp / api_call)
const result2 = await client.execute("screen-candidate", {
  payload: { candidate_id: 42 },
  onProgress: (ev) => console.log(`[${ev.step_id}] ${ev.duration_ms}ms`),
});
```

---

## Authentication

The `TuvlAuth` class wraps the most common `/auth/*` endpoints — `bootstrap`, `loginWithPassword`, `getOAuthLoginUrl`, `getMe`, `refresh`, `logout` — so you don't have to hand-craft form bodies or Biscuit decoding logic. Admin endpoints (user / role / scope CRUD, federation config) are intentionally not wrapped; call them directly with `fetch` or the lower-level `Transport` using the same Bearer token.

### `new TuvlAuth(options)`

| Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | tuvl server URL |

### Password login

```ts
const auth = new TuvlAuth({ baseUrl: "http://localhost:8000" });
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

## Transport selection

`execute()` picks the transport automatically — you never need to branch on it:

| Condition | Transport |
|---|---|
| `mode: "rest"` | Plain JSON POST |
| `mode: "sse"` | SSE stream |
| `mode: "grpc"` | gRPC-Web stream |
| `onProgress` provided **and** workflow `has_slow_steps` | SSE (auto) |
| Default | Plain JSON POST |

---

## API

### `new TuvlClient(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | — | tuvl server URL (trailing slash stripped) |
| `token` | `string` | — | Biscuit Bearer token for all requests |
| `manifestCacheTtl` | `number` | `60000` | Manifest cache TTL in ms. `0` disables caching |

### `client.execute(workflowName, options?)`

Executes a workflow and returns `Promise<TOutput>` — **the unwrapped `data` payload, identical across REST / SSE / gRPC**.

| Option | Type | Description |
|---|---|---|
| `payload` | `Record<string, unknown>` | JSON body matching the workflow's `input_schema` |
| `onProgress` | `(event: StepEvent) => void` | Called for every step event (SSE / gRPC only) |
| `onSuspended` | `(event: SuspendedEvent) => void` | Called once when the workflow hits a HITL step. After this fires the promise rejects with `TuvlWorkflowSuspendedError` |
| `mode` | `"rest" \| "sse" \| "grpc"` | Force a specific transport |
| `token` | `string` | Per-call token override |
| `signal` | `AbortSignal` | Cancellation signal |

#### Return-value contract

| Outcome | `execute()` does |
|---|---|
| Workflow returns `success: true` | Resolves with `data` |
| Workflow returns `success: false` | Rejects with `TuvlWorkflowError` (carries `.data` and `.error`) |
| Workflow suspends at a HITL step | Rejects with `TuvlWorkflowSuspendedError` (carries `.suspended`) |
| Engine raises an unhandled exception | Rejects with a plain `Error` |
| HTTP / network failure | Rejects with a plain `Error` |

```ts
import { TuvlClient, TuvlWorkflowError, TuvlWorkflowSuspendedError } from "@tuvl/client";

try {
  const candidate = await client.execute<Candidate>("screen-candidate", {
    payload: { id: 42 },
    onProgress: (ev) => console.log(ev.step_id, ev.duration_ms),
    onSuspended: (s) => renderHitlForm(s),
  });
  // candidate is the unwrapped data, fully typed
} catch (err) {
  if (err instanceof TuvlWorkflowSuspendedError) {
    // err.suspended.ui, err.suspended.schema, err.suspended.instance_id …
  } else if (err instanceof TuvlWorkflowError) {
    // err.data is the partial snapshot, err.error is the structured failure
  } else {
    // transport / engine failure
  }
}
```

### `client.getManifest(workflowName)`

Fetches (and caches) the workflow manifest from `/api/_system/workflows/{name}`. Called automatically by `execute()`.

### `client.listWorkflows()`

Returns all registered workflows with their trigger paths and streaming hints.

### `client.setToken(token)`

Updates the default auth token without recreating the client.

### `client.invalidateManifest(name?)`

Clears the manifest cache for one workflow, or all if no name is given.

---

## TypeScript types

```ts
import type {
  // Auth
  TokenResponse,    // { access_token, token_type }
  MeResponse,       // { user_id, groups, scopes }
  // Workflow execution
  StepEvent,        // single step update (event_type: "step")
  DoneEvent,        // terminal envelope { event_type:"done", success, data, error }
  ErrorEvent,       // engine-level error { event_type:"error", message, details }
  SuspendedEvent,   // HITL suspension { event_type:"suspended", instance_id, ui, schema, … }
  RestEnvelope,     // shape of the plain REST response body
  WorkflowErrorPayload, // shape of the .error field on failures
  WorkflowManifest, // shape of /api/_system/workflows/{name}
  ExecuteOptions,   // options for execute()
  TuvlClientOptions // constructor options
} from "@tuvl/client";

// Error classes are real classes — usable with `instanceof`
import { TuvlWorkflowError, TuvlWorkflowSuspendedError } from "@tuvl/client";
```

---

## Lower-level exports

The package also exports its internal building blocks for advanced use:

```ts
import { Transport }      from "@tuvl/client"; // raw HTTP layer
import { parseSseStream } from "@tuvl/client"; // SSE frame parser (async generator)
import { openGrpcStream } from "@tuvl/client"; // gRPC-Web stream (async generator)
```

---

## License

MIT
