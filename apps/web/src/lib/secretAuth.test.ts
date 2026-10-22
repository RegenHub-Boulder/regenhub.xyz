import { describe, expect, it } from "vitest";
import { hasBearerSecret } from "./secretAuth";

function req(authorization?: string): Request {
  return new Request("http://localhost/api/cron/x", {
    method: "POST",
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

describe("hasBearerSecret", () => {
  const secret = "s3cret-value";

  it("accepts the exact bearer header", () => {
    expect(hasBearerSecret(req(`Bearer ${secret}`), secret)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(hasBearerSecret(req(), secret)).toBe(false);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(hasBearerSecret(req(`Bearer ${"x".repeat(secret.length)}`), secret)).toBe(false);
  });

  it("rejects wrong-length secrets: prefix, extension, empty", () => {
    expect(hasBearerSecret(req(`Bearer ${secret.slice(0, -1)}`), secret)).toBe(false);
    expect(hasBearerSecret(req(`Bearer ${secret}x`), secret)).toBe(false);
    expect(hasBearerSecret(req("Bearer "), secret)).toBe(false);
    expect(hasBearerSecret(req(""), secret)).toBe(false);
  });

  it("rejects the secret without the Bearer scheme, or with a different scheme", () => {
    expect(hasBearerSecret(req(secret), secret)).toBe(false);
    expect(hasBearerSecret(req(`Basic ${secret}`), secret)).toBe(false);
  });

  it("fails closed when the secret is unset, empty or blank", () => {
    // An unset env must never match a caller who sends "Bearer undefined"
    // or "Bearer " — the classic template-string trap.
    expect(hasBearerSecret(req("Bearer undefined"), undefined)).toBe(false);
    expect(hasBearerSecret(req("Bearer "), undefined)).toBe(false);
    expect(hasBearerSecret(req("Bearer "), "")).toBe(false);
    expect(hasBearerSecret(req("Bearer    "), "   ")).toBe(false);
  });
});
