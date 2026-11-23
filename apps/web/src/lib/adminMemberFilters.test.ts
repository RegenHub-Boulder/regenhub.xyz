import { describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../../test/memoryDb";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { GET } from "@/app/api/admin/users/route";
import type { AdminUsersResponse } from "@/app/api/admin/users/route";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { countUnbilledDesks, matchesStatusFilter } from "./adminMemberFilters";

const member = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, email: `${name.toLowerCase()}@example.test`, disabled: false, is_admin: false,
  member_type: "hot_desk", supabase_user_id: `uid-${id}`, day_passes_balance: 0, ...extra,
});
const subscription = (id: number, memberId: number, rail: string, status: string) => ({
  id, member_id: memberId, payment_rail: rail, status, plan_key: "hot_desk", monthly_cents: 25000,
  net_cents: 25000, cancel_at_period_end: false, past_due_since: status === "past_due" ? "2026-10-01T00:00:00.000Z" : null,
});

describe("Overdue filter on /admin/members", () => {
  it("returns past_due members on both rails, and nobody else", async () => {
    const db = makeMemoryDb({
      auth_users: [1, 2, 3, 4, 5].map((id) => ({ id: `uid-${id}`, email: `m${id}@example.test`, created_at: "2026-01-01" })),
      members: [
        member(1, "Ada", { is_admin: true }),
        member(2, "CardLate"),
        member(3, "CryptoLate"),
        member(4, "CardFine"),
        member(5, "Gone"),
        member(6, "LegacyCryptoLate", { supabase_user_id: null }),
      ],
      subscriptions: [
        subscription(1, 2, "stripe", "past_due"),
        subscription(2, 3, "onchain", "past_due"),
        subscription(3, 4, "stripe", "active"),
        subscription(4, 5, "onchain", "canceled"),
        subscription(5, 6, "onchain", "past_due"),
      ],
      applications: [],
    }, { user: { id: "uid-1", email: "m1@example.test" } });
    vi.mocked(createClient).mockResolvedValue(db as never);
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as AdminUsersResponse;

    const overdueUsers = data.users.filter((u) => matchesStatusFilter(u.member, u.subscription, "overdue"));
    const overdueLegacy = data.legacyMembers.filter((m) => matchesStatusFilter(m, m.subscription, "overdue"));
    expect(overdueUsers.map((u) => [u.member?.name, u.subscription?.payment_rail]).sort()).toEqual([
      ["CardLate", "stripe"], ["CryptoLate", "onchain"],
    ]);
    expect(overdueLegacy.map((m) => [m.name, m.subscription?.payment_rail])).toEqual([["LegacyCryptoLate", "onchain"]]);
  });

  it("keeps the existing status filters' meaning", () => {
    const live = { status: "active" };
    expect(matchesStatusFilter({ disabled: false }, live, "active")).toBe(true);
    expect(matchesStatusFilter({ disabled: true }, live, "active")).toBe(false);
    expect(matchesStatusFilter({ disabled: true }, null, "disabled")).toBe(true);
    expect(matchesStatusFilter({ disabled: false }, null, "no_subscription")).toBe(true);
    expect(matchesStatusFilter({ disabled: false }, live, "no_subscription")).toBe(false);
    expect(matchesStatusFilter(null, null, "active")).toBe(false);
    expect(matchesStatusFilter(null, null, "all")).toBe(true);
    expect(matchesStatusFilter({ disabled: false }, live, "overdue")).toBe(false);
  });
});

describe("Unbilled desks: the admin home's count is the list its link opens", () => {
  it("counts and lists the same people, on both rails, including a stale auth link", async () => {
    const members = [
      member(1, "Ada", { is_admin: true, member_type: "hub_friend" }),
      member(2, "DeskNoSub"),                                              // counted
      member(3, "ColdNoSub", { member_type: "cold_desk" }),                // counted
      member(4, "DeskCard"),                                               // billed (card)
      member(5, "DeskCryptoLate"),                                         // billed (past due still billed)
      member(6, "DeskCanceled"),                                           // only a canceled row: counted
      member(7, "DeskDisabled", { disabled: true }),                       // disabled: not counted
      member(8, "DayPassNoSub", { member_type: "day_pass" }),              // no_subscription, but not a desk
      member(9, "LegacyDesk", { supabase_user_id: null }),                 // counted, no auth account
      member(10, "StaleLinkDesk", { supabase_user_id: "uid-gone" }),      // counted, auth user deleted
    ];
    const subscriptions = [
      subscription(1, 4, "stripe", "active"),
      subscription(2, 5, "onchain", "past_due"),
      subscription(3, 6, "stripe", "canceled"),
    ];
    const db = makeMemoryDb({
      auth_users: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id: `uid-${id}`, email: `m${id}@example.test`, created_at: "2026-01-01" })),
      members, subscriptions, applications: [],
    }, { user: { id: "uid-1", email: "m1@example.test" } });
    vi.mocked(createClient).mockResolvedValue(db as never);
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    const data = (await (await GET()).json()) as AdminUsersResponse;
    const listed = [
      ...data.users.filter((u) => matchesStatusFilter(u.member, u.subscription, "unbilled_desk")).map((u) => u.member!.name),
      ...data.legacyMembers.filter((m) => matchesStatusFilter(m, m.subscription, "unbilled_desk")).map((m) => m.name),
    ].sort();
    expect(listed).toEqual(["ColdNoSub", "DeskCanceled", "DeskNoSub", "LegacyDesk", "StaleLinkDesk"]);
    // The admin home reads desk-type members and every subscription row, then counts with the same predicate.
    const deskRows = members.filter((m) => m.member_type === "cold_desk" || m.member_type === "hot_desk");
    expect(countUnbilledDesks(deskRows, subscriptions)).toBe(listed.length);
    // The old link (any type, no subscription) is wider: that was the mismatch Aaron saw.
    const noSub = [
      ...data.users.filter((u) => matchesStatusFilter(u.member, u.subscription, "no_subscription")),
      ...data.legacyMembers.filter((m) => matchesStatusFilter(m, m.subscription, "no_subscription")),
    ];
    expect(noSub.length).toBeGreaterThan(listed.length);
  });
});
