import { describe, expect, it } from "vitest";
import { namesText, planWords, whoIsComing } from "./whoIsComing";
import type { FollowupMember, FollowupTechnePerson } from "./nightFollowups";

const member = (id: number, name: string, did: string | null, member_type: string, email: string | null = `${name.toLowerCase()}@example.test`): FollowupMember =>
  ({ id, name, email, did, member_type, disabled: false, show_in_directory: null });
const techne = (did: string, p: Partial<FollowupTechnePerson> = {}): FollowupTechnePerson =>
  ({ did, handle: null, name: null, email: null, email_confirmed: false, member_id: null, ...p });

const members = [
  member(1, "Ana", "did:plc:ana", "hot_desk"),
  member(2, "Bo", "did:plc:bo", "day_pass"),
  member(3, "Cy", null, "day_pass", "cy@example.test"),
  member(4, "Dee", "did:plc:dee", "day_pass"),
  { ...member(5, "Eve", "did:plc:eve", "hot_desk"), disabled: true },
];
const people = [
  techne("did:plc:ana", { handle: "ana.techne.town" }),
  // Cy's Techne account matched Cy's member row by a confirmed email at sign-in.
  techne("did:plc:cy", { handle: "cy.techne.town", email: "CY@example.test", email_confirmed: true, member_id: 3 }),
  // An account that claims Dee's row but whose email no longer matches it: a guest, not Dee.
  techne("did:plc:moved", { handle: "moved.techne.town", name: "Moved", email: "other@example.test", email_confirmed: true, member_id: 4 }),
  techne("did:plc:kim", { handle: "kim.techne.town", name: "Kim", email: "kim@example.test", email_confirmed: true }),
  techne("did:plc:unconf", { handle: "unconf.other.pds", email: "unconf@example.test", email_confirmed: false }),
];
const subs = [
  { member_id: 2, status: "active", monthly_cents: 5000, plan_key: "member_2day" },
  { member_id: 4, status: "canceled", monthly_cents: 3000, plan_key: "member_basic" },
];
const rsvps = ["did:plc:eve", "did:plc:kim", "did:plc:unconf", "did:plc:nobody0000000000000000", "did:plc:moved", "did:plc:bo", "did:plc:cy", "did:plc:ana"]
  .map((did, i) => ({ did, at: `2026-11-${10 + i}T00:00:00Z` }));

describe("who's coming", () => {
  it("maps each DID to a member (with plan) or a guest (named from techne_people or the handle), members first", () => {
    const list = whoIsComing(rsvps, { members, people, subs }, { withEmails: true, handles: new Map([["did:plc:bo", "bo.techne.town"]]) });
    expect(list.map((p) => [p.name, p.handle, p.kind, p.plan])).toEqual([
      ["Ana", "ana.techne.town", "member", "Hot Desk"],
      ["Bo", "bo.techne.town", "member", "Member + 2 days/mo"],
      ["Cy", "cy.techne.town", "member", null],
      ["Eve", null, "member", "Account disabled"],
      ["@unconf.other.pds", "unconf.other.pds", "guest", null],
      ["did:plc:nobo…0000", null, "guest", null],
      ["Kim", "kim.techne.town", "guest", null],
      ["Moved", "moved.techne.town", "guest", null],
    ]);
    expect(list.find((p) => p.name === "Bo")?.rsvpAt).toBe("2026-11-15T00:00:00Z");
    // An admin's list: only addresses this site may use (never an unconfirmed one).
    expect(Object.fromEntries(list.map((p) => [p.name, p.email]))).toMatchObject({
      Ana: "ana@example.test", Cy: "cy@example.test", Kim: "kim@example.test", Moved: "other@example.test", "@unconf.other.pds": undefined,
    });
  });

  it("gives no email field at all without withEmails, and Copy names never carries one", () => {
    const list = whoIsComing(rsvps, { members, people, subs }, { withEmails: false });
    expect(list.every((p) => !("email" in p))).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/@example\.test/);
    expect(namesText(list).split("\n").slice(0, 2)).toEqual(["Ana (@ana.techne.town)", "Bo"]);
    expect(namesText(list)).not.toMatch(/example\.test/);
  });

  it("names a plan from the member type, else the dearest paying subscription", () => {
    expect(planWords({ member_type: "hub_friend" }, [])).toBe("Hub friend");
    expect(planWords({ member_type: "cold_desk" }, [])).toBe("Cold Desk");
    expect(planWords({ member_type: "day_pass" }, [
      { status: "active", monthly_cents: 3000, plan_key: "member_basic" },
      { status: "trialing", monthly_cents: 10000, plan_key: "member_5day" },
    ])).toBe("Member + 5 days/mo");
    expect(planWords({ member_type: "day_pass" }, [{ status: "past_due", monthly_cents: 3000, plan_key: "member_basic" }])).toBeNull();
    expect(planWords({ member_type: "day_pass" }, [{ status: "active", monthly_cents: 4000, plan_key: "custom" }])).toBe("Paid plan");
  });
});

describe("who's coming: edges", () => {
  it("never links by email when both addresses are missing (a member with no email, an unconfirmed account)", () => {
    const noEmail = member(9, "Nia", null, "hot_desk", null);
    const stale = techne("did:plc:stale", { handle: "stale.techne.town", member_id: 9, email: "x@example.test", email_confirmed: false });
    const [p] = whoIsComing([{ did: "did:plc:stale", at: "" }], { members: [noEmail], people: [stale], subs: [] }, { withEmails: true });
    expect([p.name, p.kind, p.email]).toEqual(["@stale.techne.town", "guest", undefined]);
  });
});
