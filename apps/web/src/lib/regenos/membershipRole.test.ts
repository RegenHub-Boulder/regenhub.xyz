import { describe, it, expect } from "vitest";
import { planMembership, type MemberAxes } from "./membershipRole";

const base: MemberAxes = {
  did: "did:plc:alice",
  disabled: false,
  is_admin: false,
  is_ops_admin: false,
};

describe("planMembership", () => {
  it("skips rows with no DID", () => {
    expect(planMembership({ ...base, did: null })).toEqual({ action: "skip", reason: "no DID" });
    expect(planMembership({ ...base, did: "  " })).toEqual({ action: "skip", reason: "no DID" });
  });

  it("revokes a disabled member who still has a DID", () => {
    expect(planMembership({ ...base, disabled: true })).toEqual({
      action: "revoke",
      did: "did:plc:alice",
    });
  });

  it("maps admin / ops-admin to steward; everyone else with a DID is member", () => {
    expect(planMembership({ ...base, is_admin: true })).toMatchObject({ role: "steward" });
    expect(planMembership({ ...base, is_ops_admin: true })).toMatchObject({ role: "steward" });
    expect(planMembership(base)).toMatchObject({ action: "set", role: "member" });
  });
});
