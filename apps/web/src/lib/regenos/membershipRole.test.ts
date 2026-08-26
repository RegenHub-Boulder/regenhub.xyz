import { describe, it, expect } from "vitest";
import { planMembership, type MemberAxes } from "./membershipRole";

const base: MemberAxes = {
  did: "did:plc:alice",
  disabled: false,
  is_admin: false,
  is_ops_admin: false,
  is_coop_member: false,
  member_type: "hub_friend",
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

  it("maps admin / ops-admin to steward, co-op to facilitator, desk to builder", () => {
    expect(planMembership({ ...base, is_admin: true })).toMatchObject({ role: "steward" });
    expect(planMembership({ ...base, is_ops_admin: true })).toMatchObject({ role: "steward" });
    expect(planMembership({ ...base, is_coop_member: true })).toMatchObject({ role: "facilitator" });
    expect(planMembership({ ...base, member_type: "hot_desk" })).toMatchObject({ role: "builder" });
    expect(planMembership({ ...base, member_type: "cold_desk" })).toMatchObject({ role: "builder" });
    expect(planMembership({ ...base, member_type: "day_pass" })).toMatchObject({ role: "member" });
  });

  it("admin wins over desk type", () => {
    expect(planMembership({ ...base, is_admin: true, member_type: "hot_desk" })).toMatchObject({
      role: "steward",
    });
  });
});
