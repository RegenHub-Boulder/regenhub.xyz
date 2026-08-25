import { describe, it, expect } from "vitest";
import { isSyntheticEmail, syntheticEmailForDid, SYNTHETIC_EMAIL_DOMAIN } from "./syntheticEmail";

describe("syntheticEmailForDid", () => {
  it("is stable for a plc did and uses the reserved domain", () => {
    const did = "did:plc:dl3lexgjfg2euvkqvao4wsgs";
    const a = syntheticEmailForDid(did);
    expect(a).toBe(`did-plc-dl3lexgjfg2euvkqvao4wsgs@${SYNTHETIC_EMAIL_DOMAIN}`);
    expect(syntheticEmailForDid(did)).toBe(a);
    expect(isSyntheticEmail(a)).toBe(true);
  });

  it("does not claim a real address", () => {
    expect(isSyntheticEmail("member@example.com")).toBe(false);
    expect(isSyntheticEmail(null)).toBe(false);
  });

  it("hashes instead of truncating a long did", () => {
    const did = `did:web:${"a".repeat(80)}.example`;
    const email = syntheticEmailForDid(did);
    expect(email.startsWith("did-")).toBe(true);
    expect(email.endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`)).toBe(true);
    expect(email.split("@")[0]!.length).toBeLessThanOrEqual(64);
    expect(syntheticEmailForDid(did)).toBe(email);
  });
});
