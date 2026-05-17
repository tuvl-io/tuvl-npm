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

The `TuvlAuth` class handles every `/auth/*` operation. You never have to construct raw `fetch` calls or deal with Biscuit token encoding.

### `new TuvlAuth(options)`

| Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | tuvl server URL |

### Password login

```ts
const auth = new TuvlAuth({ baseUrl: "http://localhost:8000" });
const { access_token } = await auth.loginWithPassword("me@example.com", "secret");
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

Executes a workflow and returns `Promise<TOutput>` — the final output regardless of transport.

| Option | Type | Description |
|---|---|---|
| `payload` | `Record<string, unknown>` | JSON body matching the workflow's `input_schema` |
| `onProgress` | `(event: StepEvent) => void` | Called for every step event (SSE / gRPC only) |
| `mode` | `"rest" \| "sse" \| "grpc"` | Force a specific transport |
| `token` | `string` | Per-call token override |
| `signal` | `AbortSignal` | Cancellation signal |

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
  StepEvent,        // single step update
  DoneEvent,        // terminal success
  ErrorEvent,       // terminal failure
  WorkflowManifest, // shape of /api/_system/workflows/{name}
  ExecuteOptions,   // options for execute()
  TuvlClientOptions // constructor options
} from "@tuvl/client";
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
