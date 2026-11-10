# @tuvl/client — Agentic SDK Manual

> **Audience:** AI coding agents generating TypeScript that calls a tuvl 2.0 server.
> **Contract:** `@tuvl/client@2.x`. Never invent methods, options or fields absent here; the README and `AGENTS.md` carry the same contract.
> **Server side:** the tuvl 2.0 agentic manual (`tuvl` package docs) and `/openapi.json` of the running server.

## 1. Mental model

```
your code ──TuvlClient──▶ POST /api/workflows/{name}/runs ──▶ durable run (journal)
                              │ 2xx end body ◀──┘   │ 202 + run descriptor
                              ▼                     ▼
                         typed output          RunHandle: events() over SSE, wait(),
                                               pause/resume/abort/steer
                         approvals.list/decide ◀── runs waiting on a person or a tool approval
```

- A workflow run is durable: it survives restarts and can wait on people. The HTTP call only waits up to the trigger's `sync_timeout`.
- Every run has a journal: `RunHandle.events()` replays it, then follows live.
- Types come from the server: `npx tuvl-client generate` reads `/openapi.json` (each trigger is tagged `x-tuvl-workflow`) and writes a `Workflows` type.

## 2. API

| Call | Does |
|---|---|
| `new TuvlClient<W>({ baseUrl, token? })` | client; `W` = generated `Workflows` |
| `execute(name, input, { token?, signal? })` | start and wait: end body, or `RunHandle` on 202 |
| `start(name, input)` | start without waiting: `RunHandle` |
| `run(id)` | handle on an existing run |
| `runs.list({ workflow?, status?, limit? })` / `runs.get(id)` / `runs.events(id, { fromSeq?, follow? })` / `runs.control(id, action, message?)` / `runs.export(id)` | run API |
| `approvals.list()` / `approvals.decide(id, { values? , decision?, edited_args?, message? })` | approvals the caller may decide |
| `crud<TRead, TCreate, TUpdate>(model)` | CRUD on models with `spec.api.crud` |
| `RunHandle.onToken(listener, { onReset?, agentId? })` / `tokens()` / `stream()` (and `runs.tokens` / `runs.stream`) | live draft of an `llm` answer with `stream_tokens: true`; `events()` never carries drafts |
| `runs.webhooks(runId)` / `redeliverWebhook` | a run's webhook notifications; send one again |
| `verifyWebhook(rawBody, signatureHeader, secrets)` / `webhookHandler({ secrets, onNotification })` / `WebhookError` | receive and verify `spec.webhooks` notifications |
| `RunHandle.get / events / wait({ intervalMs?, timeoutMs?, untilWaiting? }) / pause / resume / abort / steer(message)` | per run |
| `TuvlAuth` | `/auth/*`: `loginWithPassword`, `bootstrap` (dev server only), `getOAuthLoginUrl`, `refresh`, `getMe`, `logout` |
| `roles()` → `RolesClient` | role membership, tuvl >= 2.1.0b2 with `roles` exposed and `roles:manage`: `isAvailable()` / `list()` / `members(roleId, { limit?, cursor? })` / `findUsers({ q?, limit?, cursor? })` / `addUser(roleId, userId)` / `removeUser(roleId, userId)` / `setActive(roleId, active)` / `disable` / `enable`. Creating roles, scopes and users are not wrapped: they are development-time (`RoleSeed`, `tuvl iam`) |

## 3. Outcomes

| Situation | Result |
|---|---|
| run reached an end with status < 400 | `execute` resolves the body; `wait()` resolves it |
| run waits (`waiting_human`, `waiting_approval`, `paused`) or is still running after `sync_timeout` | `execute` resolves a `RunHandle` |
| end with status ≥ 400, failed, aborted, compensated | rejects `TuvlRunError { status, body, runId }` |
| 401 / 403 / 404 / 422 input | rejects `TuvlApiError { status, detail }` (`detail` is the server's `detail`, e.g. a list of `{ loc, msg }`) |
| any refused request from `crud(...)`, `roles()` or `TuvlAuth` (login, refresh, logout, `getMe`, `bootstrap`) | the same `TuvlApiError { status, detail, path }`; their helpers take `{ signal }` to cancel |

## 4. Scopes

| Need | Scope |
|---|---|
| start a workflow | the workflow's `required_scope` / `required_group` (none for `public: true`) |
| read your runs | `runs:read` (`iam:admin` reads all) |
| pause / resume / abort / steer | `runs:control` |
| decide approvals | `approvals:decide` + the agent's `required_group` |
| CRUD | `{model}:read` / `{model}:write` / `{model}:delete` |

## 5. Rules

1. Generate types; do not hand-write workflow inputs/outputs.
2. Always handle `RunHandle` from `execute` — any workflow with a human agent or a slow agent can return one.
3. Use `approvals.decide` to answer a person; there is no "resume instance" call.
4. Use `events()` for progress; do not poll `runs.get` in a tight loop (use `wait({ intervalMs })`).
5. Pass `signal` to cancel long `events()` streams.
6. For a workflow whose trigger has `http.upload`, pass a `File` or `Blob` as the `file` input: the client sends `multipart/form-data`. Never base64 a file into JSON and never forge a file reference.
7. Verify a webhook against the raw body (`verifyWebhook` / `webhookHandler`) and de-duplicate on the notification id; pull the run yourself, the notification carries no output.
8. To show an answer while it is written, use `onToken` (`token_delta` / `token_reset`), clear the draft on reset, and still take the result from `wait()`: drafts are not journaled and are not kept.
