import { describe, expect, it } from "vitest";
import { loginUrlFor, safeNextPath } from "./safeNext";

describe("safeNextPath", () => {
  it("accepts same-origin relative paths", () => {
    expect(safeNextPath("/portal/passes")).toBe("/portal/passes");
    expect(safeNextPath("/admin/newsletter?x=1&y=a%20b")).toBe("/admin/newsletter?x=1&y=a%20b");
    expect(safeNextPath("/oauth/authorize?client_id=a.b")).toBe("/oauth/authorize?client_id=a.b");
  });
  it.each([
    "//evil.com", "/\\evil.com", "https://evil.com", "evil.com", "javascript:alert(1)",
    "/\nfoo", "", "/ok\\..\\x", "/\t/evil.com",
    // Dot segments that resolve to "//evil.com": router.push hands that to the
    // browser as a protocol-relative URL.
    "/.//evil.com", "/..//evil.com", "/%2e//evil.com", "/%2E%2E//evil.com", "/x/..//evil.com",
  ])("rejects %j", (bad) => {
    expect(safeNextPath(bad)).toBeUndefined();
  });
  it("returns the resolved path, so what is checked is what is followed", () => {
    expect(safeNextPath("/portal/./passes")).toBe("/portal/passes");
    expect(safeNextPath("/admin/../portal?x=1#top")).toBe("/portal?x=1#top");
  });
  it("rejects null/undefined", () => {
    expect(safeNextPath(null)).toBeUndefined();
    expect(safeNextPath(undefined)).toBeUndefined();
  });
});

describe("loginUrlFor", () => {
  it("encodes a safe destination", () => {
    expect(loginUrlFor("/portal/passes?a=1")).toBe("/auth/login?next=%2Fportal%2Fpasses%3Fa%3D1");
  });
  it("drops an unsafe destination", () => {
    expect(loginUrlFor("//evil.com")).toBe("/auth/login");
    expect(loginUrlFor(undefined)).toBe("/auth/login");
  });
});
