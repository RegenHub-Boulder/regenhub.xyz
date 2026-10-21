import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../../../../../../../test/memoryDb";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stripe")>(),
  getStripe: vi.fn(),
}));
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  clearUserCode: vi.fn(async () => [{ entity: "lock.front_door_lock", ok: true }]),
}));

import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { clearUserCode } from "@regenhub/shared";

function world(actor: { is_admin: boolean; disabled: boolean } | null) {
  const db = makeMemoryDb({
    members: [
      ...(actor ? [{ id: 1, name: "Ada Admin", supabase_user_id: "actor-uid", member_type: "hot_desk", pin_code_slot: null, ...actor }] : []),
      { id: 7, name: "Pat Example", is_admin: false, disabled: false, supabase_user_id: null, member_type: "hot_desk", pin_code_slot: 12 },
    ],
    subscriptions: [{
      id: 50, member_id: 7, payment_rail: "onchain", plan_key: "hot_desk", monthly_cents: 25000, status: "past_due",
      current_period_end: "2026-10-01T18:00:00.000Z", past_due_since: "2026-10-01T18:00:00.000Z",
      cancel_at_period_end: false, canceled_at: null, stripe_subscription_id: null, wallet_id: 3,
    }],
    onchain_invoices: [{ id: 801, subscription_id: 50, member_id: 7, period_start: "2026-10-01T18:00:00.000Z", status: "open" }],
    admin_actions: [],
  }, { user: actor ? { id: "actor-uid", email: "ada@example.test" } : null });
  vi.mocked(createClient).mockResolvedValue(db as never);
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  return db;
}

function call(body: unknown) {
  return POST(
    new Request("http://localhost/api/admin/members/7/cancel-membership", { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "7" }) },
  );
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/admin/members/[id]/cancel-membership", () => {
  it.each([
    ["logged out", null, 401],
    ["a non-admin", { is_admin: false, disabled: false }, 403],
    ["a disabled admin", { is_admin: true, disabled: true }, 403],
  ] as const)("refuses %s before any service-role read", async (_label, actor, status) => {
    const db = world(actor);
    const res = await call({ mode: "now", void_open_invoices: true });
    expect(res.status).toBe(status);
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(db.tables.subscriptions[0].status).toBe("past_due");
    expect(db.tables.onchain_invoices[0].status).toBe("open");
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("rejects an unknown mode", async () => {
    world({ is_admin: true, disabled: false });
    expect((await call({ mode: "yesterday" })).status).toBe(400);
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("an active admin cancels now, voids invoices and is named in the audit row with the reason", async () => {
    const db = world({ is_admin: true, disabled: false });
    const res = await call({ mode: "now", reason: "  Hasn't been in since July  ", void_open_invoices: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ outcome: "canceled", rail: "onchain", voidedInvoiceIds: ["801"] });
    expect(db.tables.subscriptions[0].status).toBe("canceled");
    expect(db.tables.onchain_invoices[0].status).toBe("void");
    expect(clearUserCode).toHaveBeenCalledWith(12);
    expect(db.tables.admin_actions).toEqual([expect.objectContaining({
      actor_member_id: 1,
      action: "subscription_canceled_by_admin",
      target_id: "7",
      payload: expect.objectContaining({ reason: "Hasn't been in since July", rail: "onchain", mode: "now", voided_invoice_ids: ["801"] }),
    })]);

    const again = await call({ mode: "now" });
    expect(again.status).toBe(200);
    expect((await again.json()).outcome).toBe("already_canceled");
    expect(db.tables.admin_actions).toHaveLength(1);
  });
});
