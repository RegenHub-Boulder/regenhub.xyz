import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unsubscribeToken, verifyUnsubscribeToken } from "./newsletter";

const EMAIL = "someone@example.com";

describe("newsletter unsubscribe tokens", () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    env = { ...process.env };
    delete process.env.NEWSLETTER_UNSUBSCRIBE_SECRET;
    delete process.env.CRON_SECRET;
  });

  afterEach(() => {
    process.env = env;
  });

  it("signs with the dedicated secret when it is set", () => {
    process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = "dedicated";
    const token = unsubscribeToken(EMAIL);

    process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = "different";
    expect(unsubscribeToken(EMAIL)).not.toBe(token);
  });

  it("prefers the dedicated secret over CRON_SECRET", () => {
    process.env.CRON_SECRET = "cron";
    const cronSigned = unsubscribeToken(EMAIL);

    process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = "dedicated";
    expect(unsubscribeToken(EMAIL)).not.toBe(cronSigned);
  });

  it("still accepts links signed with CRON_SECRET after the new secret is added", () => {
    process.env.CRON_SECRET = "cron";
    const alreadyMailed = unsubscribeToken(EMAIL);

    process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = "dedicated";
    expect(verifyUnsubscribeToken(EMAIL, alreadyMailed)).toBe(true);
    expect(verifyUnsubscribeToken(EMAIL, unsubscribeToken(EMAIL))).toBe(true);
  });

  it("is case-insensitive on the email but rejects a different address", () => {
    process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = "dedicated";
    const token = unsubscribeToken(EMAIL);
    expect(verifyUnsubscribeToken("SOMEONE@EXAMPLE.COM", token)).toBe(true);
    expect(verifyUnsubscribeToken("someone.else@example.com", token)).toBe(false);
  });

  it("rejects a token that wasn't signed by any accepted key", () => {
    process.env.NEWSLETTER_UNSUBSCRIBE_SECRET = "dedicated";
    expect(verifyUnsubscribeToken(EMAIL, "0".repeat(32))).toBe(false);
    expect(verifyUnsubscribeToken(EMAIL, "")).toBe(false);
    expect(verifyUnsubscribeToken(EMAIL, "short")).toBe(false);
  });

  it("throws in production when no secret is configured", () => {
    const prevNodeEnv = process.env.NODE_ENV;
    Object.defineProperty(process.env, "NODE_ENV", { value: "production", configurable: true, writable: true });
    try {
      expect(() => unsubscribeToken(EMAIL)).toThrow(/NEWSLETTER_UNSUBSCRIBE_SECRET/);
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", { value: prevNodeEnv, configurable: true, writable: true });
    }
  });

  it("falls back to a development secret outside production", () => {
    expect(() => unsubscribeToken(EMAIL)).not.toThrow();
  });
});
