import { describe, expect, it } from "vitest";
import { createWalletChallenge } from "./walletChallenge";

describe("wallet challenge", () => {
  it("binds the domain, address, OP chain, member, and ten-minute expiry", () => {
    const now = new Date("2026-08-26T17:00:00.000Z");
    const result = createWalletChallenge({
      address: "0x1111111111111111111111111111111111111111",
      memberId: 42,
      siteUrl: "https://regenhub.xyz",
      now,
    });
    expect(result.message).toContain("regenhub.xyz wants you to verify this wallet");
    expect(result.message).toContain("Chain ID: 10");
    expect(result.message).toContain("regenhub:member:42");
    expect(result.expiresAt.toISOString()).toBe("2026-08-26T17:10:00.000Z");
    expect(result.nonceHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
