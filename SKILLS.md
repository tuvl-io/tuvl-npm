# @tuvl/client Skills for AI Agents

The following skills represent standard procedural knowledge for using the `@tuvl/client` SDK. Use these patterns to map requirements into correct TypeScript code.

---
name: authenticate-user
description: Login a user with an email and password to retrieve an access token.
options:
  argument-hint: "[email] [password]"
---

### Body

1. Instantiate `TuvlAuth` with the server URL.
2. Call `loginWithPassword` and extract the token.
3. Pass the token to the `TuvlClient`.

```ts
import { TuvlAuth, TuvlClient } from "@tuvl/client";

const auth = new TuvlAuth({ baseUrl: "http://localhost:8885" });
const client = new TuvlClient({ baseUrl: "http://localhost:8885" });

const { access_token } = await auth.loginWithPassword("user@example.com", "password123");
client.setToken(access_token);
```

---
name: generate-types
description: Generate typed workflow inputs and outputs from a running server.
options:
  argument-hint: "[server-url]"
---

### Body

1. Run the generator against the server (or a saved `openapi.json`).
2. Construct the client with the generated `Workflows` type.

```bash
npx tuvl-client generate --url http://localhost:8885 --out src/tuvl.generated.ts
```

```ts
import { TuvlClient } from "@tuvl/client";
import type { Workflows } from "./tuvl.generated";

const client = new TuvlClient<Workflows>({ baseUrl: "http://localhost:8885", token });
```

---
name: execute-workflow
description: Run a workflow by name and handle every outcome.
options:
  argument-hint: "[workflow-name]"
---

### Body

1. Call `client.execute(name, input)`.
2. A `RunHandle` means the run waits on a person/approval or is still running.
3. Catch `TuvlRunError` (error end, failure, abort) and `TuvlApiError` (refused request).

```ts
import { RunHandle, TuvlApiError, TuvlRunError } from "@tuvl/client";

try {
  const result = await client.execute("triage_ticket", { subject, body, customer_email });
  if (result instanceof RunHandle) {
    const output = await result.wait({ timeoutMs: 60_000, untilWaiting: true });
    if (output === undefined) console.log("waiting on", result.run?.current_agent);
  } else {
    console.log(result.category);
  }
} catch (err) {
  if (err instanceof TuvlRunError) console.error(err.status, err.body);
  else if (err instanceof TuvlApiError) console.error(err.status, err.detail);
  else throw err;
}
```

---
name: decide-approval
description: Answer a run that waits on a person or a tool-call approval.
options:
  argument-hint: "[run-id]"
---

### Body

1. List the approvals the caller may decide and pick the run's.
2. Submit form values (human agent) or a decision (tool call).
3. Wait for the run's output.

```ts
const handle = client.run(runId);
const approval = (await client.approvals.list()).find((a) => a.run_id === runId);
if (approval?.kind === "human") await client.approvals.decide(approval.approval_id, { values: { approved: true } });
else if (approval) await client.approvals.decide(approval.approval_id, { decision: "approve" });
const output = await handle.wait();
```

---
name: upload-file
description: Start a workflow whose trigger accepts file uploads (`http.upload`), from a browser or Node.
options:
  argument-hint: "[workflow-name]"
---

### Body

1. The workflow's `trigger.input` has a `file` (or `list[file]`) input and its HTTP trigger declares `upload`.
2. Pass a `File` or `Blob` as that input's value (an array of them for `list[file]`). The client sends `multipart/form-data`; other values go
   as text or JSON text. Do not base64 a file into a JSON field, and never build the file reference yourself: the server makes it.
3. Handle the result as for any run (`RunHandle` or the end's body). A refused file answers `TuvlApiError`: 413 too large, 415 type not
   accepted, 400 too many files, 422 a value that is not a file for a file input.

```ts
const result = await client.execute("intake", { invoice: fileInput.files[0], note: "March" });
```

---
name: receive-webhook
description: Be told when a run completes, fails or waits, instead of polling (`spec.webhooks`).
options:
  argument-hint: "[run-id]"
---

### Body

1. A notification holds only the run id, what happened and a journal position. Pull the run with your own token (scope `runs:read`).
2. Verify the signature on the **raw** body before trusting it. `webhookHandler` does this for anything that speaks `Request`/`Response`;
   for Express use `verifyWebhook(rawBody, req.header("tuvl-signature"), secrets)`, which throws `WebhookError` (answer 401).
3. Delivery is at-least-once: ignore a notification id you have seen. Pass the old secret too while rotating.

```ts
import { TuvlClient, webhookHandler } from "@tuvl/client";

const client = new TuvlClient({ baseUrl: "https://tuvl.example.com", token: serviceToken });

export const POST = webhookHandler({
  secrets: [process.env.OPS_WEBHOOK_SECRET!],
  onNotification: async (n) => {
    if (await alreadySeen(n.id)) return;
    const run = await client.run(n.run_id).get();
    await handle(run);
  },
});
```

---
name: stream-answer
description: Show an llm agent's answer while the model is writing it (`stream_tokens: true`).
options:
  argument-hint: "[run-id]"
---

### Body

1. The agent must be declared with `llm: { stream_tokens: true }` (and `stream_field` when it has several `str` outputs). Without that, no pieces are sent.
2. Call `handle.onToken(listener, { onReset })` right after `start()` or `execute()` returns a `RunHandle`. Append each piece; on reset, clear what you showed.
3. Still await `handle.wait()` for the final result: the pieces are a preview, the output is the answer. Await `live.done` to know the stream ended.

```ts
const handle = await client.start("write_reply", { ticket });
const live = handle.onToken((piece) => (box.textContent += piece), { onReset: () => (box.textContent = "") });
const reply = await handle.wait();
await live.done;
```

---
name: follow-run
description: Stream a run's events (agents, decisions, tool calls) as they happen.
options:
  argument-hint: "[run-id]"
---

### Body

```ts
for await (const event of client.run(runId).events()) {
  console.log(event.seq, event.type, event.agent_id ?? "", event.payload);
}
```

---
name: crud-model
description: Read and write records of a model that opted into CRUD (`spec.api.crud`).
options:
  argument-hint: "[model-name]"
---

### Body

```ts
const tickets = await client.crud<Ticket>("ticket").list({ filters: { urgency: "high" }, limit: 20 });
const one = await client.crud<Ticket>("ticket").get(tickets[0].id);
```
