import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn(), getPlan: () => ({ grantsMemberType: "hot_desk" }), planLabel: () => "Desk" }));
vi.mock("@/lib/stripeRetrieveNet", () => ({ resolveSubscriptionNet: async () => ({ netCents: 50000, offCents: 0 }) }));
vi.mock("@/lib/subscriptionPasses", () => ({ grantSubscriptionPasses: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(), welcomeNewMemberEmail: vi.fn(), subscriptionEndedEmail: vi.fn(), paymentReminderEmail: vi.fn() }));
vi.mock("@regenhub/shared", () => ({
  allocateSlotWithRetry: vi.fn(), setUserCode: vi.fn(), clearUserCode: vi.fn(),
  generateRandomCode: () => "123456", formatLockStatus: () => "ok", MEMBER_SLOT_MIN: 1, MEMBER_SLOT_MAX: 100,
}));
import { POST } from "@/app/api/webhooks/stripe/route";
import { retryPendingOnchainEffects } from "./onchain/verifyPayment";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { allocateSlotWithRetry, setUserCode } from "@regenhub/shared";

function database(disabled = true) {
  const member = { id: 7, disabled, pin_code_slot: null, name: "Member", email: null };
  const writes: { table: string; values: Record<string, unknown> }[] = [];
  const db = { from: (table: string) => {
    let columns = "";
    const builder = {
      select: (value = "") => { columns = value; return builder; },
      eq: () => builder, is: () => builder, limit: () => builder,
      update: (values: Record<string, unknown>) => { writes.push({ table, values }); if (table === "members") Object.assign(member, values); return builder; },
      insert: () => builder, upsert: (values: Record<string, unknown>) => { writes.push({ table, values }); return builder; },
      single: async () => response(), maybeSingle: async () => response(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve),
    };
    function response() {
      let data: unknown = null;
      if (table === "members") data = member;
      if (table === "onchain_payments") data = columns.startsWith("id, invoice_id")
        ? [{ id: 3, invoice_id: 2, member_id: 7, onchain_invoices: { subscription_id: 1, subscriptions: { plan_key: "hot_desk" } } }]
        : columns === "id" ? { id: 3 } : { effects_claimed_at: null, effects_completed_at: null };
      return { data, error: null };
    }
    return builder;
  } };
  return { db, member, writes };
}
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call"); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("late Stripe activation reconciles billing without restoring disabled access", async () => {
  const { db, member, writes } = database();
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "test-only");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.mocked(getStripe).mockReturnValue({ webhooks: { constructEvent: () => ({ id: "evt", type: "customer.subscription.updated", data: { object: { id: "sub", customer: "cus", metadata: { plan_key: "hot_desk" }, status: "active", items: { data: [] } } } }) } } as never);
  for (let i = 0; i < 2; i++) {
    expect((await POST(new Request("http://localhost/webhook", { method: "POST", headers: { "stripe-signature": "test" }, body: "{}" }))).status).toBe(200);
  }
  expect(writes.some(w => w.table === "subscriptions" && w.values.status === "active")).toBe(true);
  expect(member.disabled).toBe(true);
  expect(writes.filter(w => w.table === "members")).toEqual([]);
  expect(setUserCode).not.toHaveBeenCalled();
  expect(allocateSlotWithRetry).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
it("on-chain credited payment retries complete without granting disabled access", async () => {
  const { db, member, writes } = database();
  await retryPendingOnchainEffects(db as never);
  await retryPendingOnchainEffects(db as never);
  expect(member.disabled).toBe(true);
  expect(writes.filter(w => w.table === "members")).toEqual([]);
  expect(writes.some(w => w.values.effects_completed_at)).toBe(true);
  expect(setUserCode).not.toHaveBeenCalled();
  expect(allocateSlotWithRetry).not.toHaveBeenCalled();
});

it("on-chain provisioning failure stays pending and surfaces after credit", async () => {
  const { db, writes } = database(false);
  vi.mocked(allocateSlotWithRetry).mockResolvedValue({ ok: false, error: "database unavailable" });
  await expect(retryPendingOnchainEffects(db as never)).rejects.toThrow("allocation error");
  expect(writes.some(w => w.values.effects_completed_at)).toBe(false);
  expect(writes.at(-1)?.values).toEqual({ effects_claimed_at: null });
});
