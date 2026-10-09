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
