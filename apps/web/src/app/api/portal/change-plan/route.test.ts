import { beforeEach, expect, it, vi } from "vitest";
import { makeSupabaseMock } from "../../../../../test/mockSupabase";
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  isStripeConfigured: () => true,
  getPlan: () => ({ selfServe: true, grantsMemberType: "day_pass", label: "Plan", defaultMonthlyCents: 100 }),
  PLANS: {}, getStripe: vi.fn(),
}));
import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
beforeEach(() => vi.clearAllMocks());
function request() {
  return new Request("http://localhost/api/portal/change-plan", { method: "POST", body: JSON.stringify({ plan_key: "contributing" }) });
}
it("refuses a disabled member before Stripe work", async () => {
  vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ auth: { user: { id: "u", email: "e" } }, selects: { members: { data: { id: 7, disabled: true } } } }) as never);
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(getStripe).not.toHaveBeenCalled();
});
it("loses the conditional write safely when admin disables after the read", async () => {
  const member = { id: 7, disabled: false };
  vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ auth: { user: { id: "u", email: "e" } }, selects: { members: { data: { ...member } } } }) as never);
  const admin = makeSupabaseMock({ selects: { subscriptions: { data: { id: 1, plan_key: "old", stripe_subscription_id: "sub" } } } });
  const original = admin.from;
  admin.from = vi.fn((table: string) => {
    if (table !== "members") return original(table);
    const filters: Record<string, unknown> = {};
    const builder = {
      update: vi.fn(() => { member.disabled = true; return builder; }),
      eq: vi.fn((key: string, value: unknown) => { filters[key] = value; return builder; }),
      select: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({ data: filters.disabled === member.disabled ? member : null, error: null })),
    };
    return builder as never;
  });
  vi.mocked(createServiceClient).mockReturnValue(admin as never);
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(member.disabled).toBe(true);
  expect(getStripe).not.toHaveBeenCalled();
});
