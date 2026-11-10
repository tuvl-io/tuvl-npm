import { describe, expect, it } from "vitest";
import * as api from "./index";

describe("public exports", () => {
  it("keeps the documented surface", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "CrudClient",
        "RolesClient",
        "RunHandle",
        "TERMINAL_STATUSES",
        "Transport",
        "TuvlApiError",
        "TuvlAuth",
        "TuvlClient",
        "TuvlRunError",
        "WAITING_STATUSES",
        "WebhookError",
        "isTokenEvent",
        "isTokenExpired",
        "parseSseEvents",
        "parseSseStream",
        "readToken",
        "tokenExpiresAt",
        "verifyWebhook",
        "webhookHandler",
      ].sort(),
    );
  });
});
