/**
 * @tuvl/client — TypeScript client for tuvl 2.0 (REST + SSE).
 *
 * @example
 * ```ts
 * import { RunHandle, TuvlClient } from "@tuvl/client";
 * import type { Workflows } from "./tuvl.generated"; // npx tuvl-client generate
 *
 * const client = new TuvlClient<Workflows>({ baseUrl: "http://localhost:8885", token });
 * const result = await client.execute("triage_ticket", { subject, body, customer_email });
 * if (result instanceof RunHandle) {
 *   for await (const event of result.events()) console.log(event.type, event.agent_id);
 * }
 * ```
 */

export { RunHandle, TuvlClient } from "./client";
export { TuvlAuth } from "./auth";
export { readToken, tokenExpiresAt, isTokenExpired } from "./token";
export type { TokenClaims } from "./token";
export type { TuvlAuthOptions, BootstrapRequest } from "./auth";
export { CrudClient } from "./crud";
export { WebhookError, verifyWebhook, webhookHandler } from "./webhooks";
export type {
  NotificationType,
  RunNotification,
  VerifyOptions,
  WebhookFailure,
  WebhookHandlerOptions,
} from "./webhooks";
export { parseSseStream } from "./sse";
export { Transport } from "./transport";
export { TERMINAL_STATUSES, TuvlApiError, TuvlRunError, WAITING_STATUSES } from "./types";
export type {
  Approval,
  ApprovalDecision,
  CrudGetOptions,
  CrudListOptions,
  CrudMutateOptions,
  MeResponse,
  RequestOptions,
  Run,
  RunEvent,
  RunEventType,
  RunStatus,
  TokenResponse,
  TuvlClientOptions,
  WebhookDelivery,
  WorkflowContract,
  WorkflowTypes,
} from "./types";
