import { describe, it, expect } from "vitest";
import { planMembership, type MemberAxes } from "./membershipRole";

const base: MemberAxes = {
  did: "did:plc:alice",
  disabled: false,
  is_admin: false,
  is_ops_admin: false,
  member_type: "hub_friend",
  hasLiveSubscription: false,
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

  it("maps admin / ops-admin to steward even if their type is day_pass", () => {
    expect(planMembership({ ...base, is_admin: true })).toMatchObject({ role: "steward" });
    expect(
      planMembership({ ...base, is_ops_admin: true, member_type: "day_pass" }),
    ).toMatchObject({ role: "steward" });
  });

  it("admits paid desk and hub friends as member without a subscription row", () => {
    expect(planMembership({ ...base, member_type: "cold_desk" })).toMatchObject({
      action: "set",
      role: "member",
    });
    expect(planMembership({ ...base, member_type: "hot_desk" })).toMatchObject({
      action: "set",
      role: "member",
    });
    expect(planMembership(base)).toMatchObject({ action: "set", role: "member" });
  });

  it("admits day-pass only when a live recurring subscription is on the row", () => {
    expect(planMembership({ ...base, member_type: "day_pass" })).toEqual({
      action: "revoke",
      did: "did:plc:alice",
    });
    expect(
      planMembership({ ...base, member_type: "day_pass", hasLiveSubscription: true }),
    ).toMatchObject({ action: "set", role: "member" });
  });
});
