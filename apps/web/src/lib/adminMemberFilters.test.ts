import { describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../../test/memoryDb";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { GET } from "@/app/api/admin/users/route";
import type { AdminUsersResponse } from "@/app/api/admin/users/route";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { matchesStatusFilter } from "./adminMemberFilters";

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
