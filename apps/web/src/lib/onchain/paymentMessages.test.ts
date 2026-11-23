import { describe, expect, it } from "vitest";
import { AUTHORIZATION_QUEUED_MESSAGE, messageAfterSignedFailure, QueuedAuthorizationError } from "./paymentMessages";

describe("messageAfterSignedFailure", () => {
  it("claims a retry only for a really queued submission", () => {
    expect(messageAfterSignedFailure(new QueuedAuthorizationError("queued")).message).toBe(AUTHORIZATION_QUEUED_MESSAGE);
  });
  it("does not claim a retry for any other error", () => {
    const out = messageAfterSignedFailure(new Error("Open invoice not found"));
    expect(out.message).not.toMatch(/retry/i);
    expect(out.error).toBe("Open invoice not found");
  });
});
