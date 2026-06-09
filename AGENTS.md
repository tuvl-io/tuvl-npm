# @tuvl/client Agent Rules

This repository uses the `@tuvl/client` SDK to interact with the TUVL server. As an AI agent working in this codebase, you must follow these rules strictly.

## 1. Do Not Invent Methods
The full public API is strictly defined:
- `TuvlClient`: `execute`, `executeVersioned`, `resumeWorkflow`, `getManifest`, `listWorkflows`, `setToken`, `invalidateManifest`, `crud`.
- `TuvlAuth`: `bootstrap`, `loginWithPassword`, `getMe`, `getOAuthLoginUrl`, `refresh`, `logout`.
Never invent methods outside this list.

## 2. Independent Instances
`TuvlAuth` and `TuvlClient` are independent. Construct them separately and share only the access token string.

## 3. Error Handling
Always wrap `execute()`, `executeVersioned()`, and `resumeWorkflow()` in `try/catch`.
- First check `err instanceof TuvlWorkflowSuspendedError` to handle Human-in-the-Loop (HITL) suspensions.
- Then check `err instanceof TuvlWorkflowError` to handle business failures.
- CRUD operations throw plain `Error` on failure, not workflow errors.

## 4. CRUD Operations
Always use `client.crud("modelName")` for database access.
- Methods available: `list(options?)`, `get(id, options?)`, `create(body, options?)`, `update(id, body, options?)`, `delete(id, options?)`.
- Never manually call `/models/` endpoints using `fetch`.
- Note: Filters must be passed as `Record<string, string>` via the `filters` option, not appended to the URL string.

## 5. HITL Resumption
- Never pass the raw `SuspendedEvent` as `humanInput`.
- Pass `instanceId` (camelCase) to `resumeWorkflow()`, which maps to the UUID from `SuspendedEvent.instance_id`.
- Do not use `mode: "grpc"` for `resumeWorkflow()`.

## 6. Project Config Requirements
- Keep `tsup.config.mts` and `vitest.config.mts` as `.mts` to force ESM loading.
- `"ignoreDeprecations": "6.0"` in `tsconfig.json` is intentional and must not be removed.
