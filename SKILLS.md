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

const auth = new TuvlAuth({ baseUrl: "http://localhost:8000" });
const client = new TuvlClient({ baseUrl: "http://localhost:8000" });

const { access_token } = await auth.loginWithPassword("user@example.com", "password123");
client.setToken(access_token);
```

---
name: execute-workflow
description: Run a TUVL workflow by name and handle the result.
options:
  argument-hint: "[workflow-name]"
---

### Body

1. Use `client.execute()` and pass the payload.
2. Wrap the execution in a `try/catch` block.
3. Check for specific SDK error types.

Note: this assumes `client` already carries a token (see `authenticate-user`). Current engines reject unauthenticated calls with 401 unless the workflow's manifest has `public: true`.

```ts
import { TuvlWorkflowError, TuvlWorkflowSuspendedError } from "@tuvl/client";

try {
  const result = await client.execute<OutputShape>("my-workflow", {
    payload: { key: "value" }
  });
  console.log("Success:", result);
} catch (err) {
  if (err instanceof TuvlWorkflowSuspendedError) {
    console.log("Suspended for HITL:", err.suspended);
  } else if (err instanceof TuvlWorkflowError) {
    console.error("Workflow failed:", err.error?.message);
  } else {
    throw err;
  }
}
```

---
name: resume-hitl-workflow
description: Resume a paused workflow by providing the required human input.
options:
  argument-hint: "[instance-id]"
---

### Body

1. Collect the human input corresponding to the suspended UI schema.
2. Call `client.resumeWorkflow()` providing the instance ID and human input.

```ts
const finalResult = await client.resumeWorkflow<OutputShape>({
  instanceId: "uuid-from-suspended-event",
  humanInput: { approved: true, note: "Looks good" }
});
```

---
name: perform-crud-operation
description: Interact with database models via the auto-generated CRUD endpoints.
options:
  argument-hint: "[model-name]"
---

### Body

1. Use `client.crud(modelName)`.
2. Wrap in a plain `try/catch` block (CRUD does not throw `TuvlWorkflowError`).
3. For fetching related records or filtering, use options.

```ts
// Fetch a list of records
const records = await client.crud<RecordType>("candidate").list({
  filters: { stage: "screening" },
  include: ["posting"],
  limit: 50
});

// Update a record
const updated = await client.crud("candidate").update(id, { stage: "interview" });
```
