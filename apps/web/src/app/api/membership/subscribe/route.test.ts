import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  isStripeConfigured: vi.fn(() => true),
  getPlan: vi.fn(() => ({
    selfServe: true,
    grantsMemberType: "hot_desk",
    defaultMonthlyCents: 25000,
    label: "Hot Desk",
    monthlyDayPasses: 0,
  })),
  getOrCreateCustomer: vi.fn(async () => ({ id: "cus_linked" })),
  getStripe: vi.fn(() => ({
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ id: "cs_linked", url: "https://checkout.example/session" })),
      },
    },
  })),
}));

import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getOrCreateCustomer } from "@/lib/stripe";

function resolvedBuilder(data: unknown) {
  const eq = vi.fn();
  const builder = {
    select: vi.fn(),
    eq,
    in: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  builder.select.mockReturnValue(builder);
  eq.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  return builder;
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/membership/subscribe", () => {
  it("uses the linked member instead of a regenOS synthetic auth email", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: {
            user: {
              id: "auth-did-1",
              email: "did-plc-abc@did.regenhub.invalid",
            },
          },
        })),
      },
    } as never);

    const member = {
      id: 42,
      name: "Aaron",
      email: "aaron@example.org",
      stripe_customer_id: "cus_linked",
      member_type: "day_pass",
      supabase_user_id: "auth-did-1",
      approved_for_daily: true,
      approved_for_full: true,
    };
    const members = resolvedBuilder(member);
    const subscriptions = resolvedBuilder(null);
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn((table: string) => table === "members" ? members : subscriptions),
    } as never);

    const response = await POST(new Request("http://localhost/api/membership/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_key: "hot_desk" }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "https://checkout.example/session" });
    expect(members.eq).toHaveBeenCalledWith("supabase_user_id", "auth-did-1");
    expect(members.eq).not.toHaveBeenCalledWith("email", "did-plc-abc@did.regenhub.invalid");
    expect(getOrCreateCustomer).toHaveBeenCalledWith(member);
  });
});
