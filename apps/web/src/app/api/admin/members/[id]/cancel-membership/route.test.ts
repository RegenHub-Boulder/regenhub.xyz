import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "../../../../../../../test/pgDb";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stripe")>(),
  getStripe: vi.fn(),
}));
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  clearUserCode: vi.fn(),
}));

import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { clearSlotSafely, clearUserCode } from "@regenhub/shared";

const ACTOR = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-000005eed000";
let db: PgDb;

/** The signed-in actor (or nobody), member #7 on a past-due crypto membership with one open invoice. */
async function world(actor: { is_admin: boolean; disabled: boolean } | null) {
  await db.exec(`insert into auth.users (id, email) values ('${ACTOR}', 'ada@example.test');
    select acquire_lock_writer('${WRITER}');
    select set_config('request.headers', '{"x-lock-writer-token":"${WRITER}"}', false);
    insert into members (id, name, member_type, pin_code_slot, pin_code) values (7, 'Pat Example', 'hot_desk', 12, '482913');
    select set_config('request.headers', '{}', false);
    select release_lock_writer('${WRITER}');
    insert into member_wallets (id, member_id, address, verification_method) values (3, 7, '0x1111111111111111111111111111111111111111', 'signature');
    insert into subscriptions (id, member_id, payment_rail, wallet_id, plan_key, monthly_cents, status, current_period_end, past_due_since)
      values (50, 7, 'onchain', 3, 'hot_desk', 25000, 'past_due', now() - interval '20 days', now() - interval '20 days');
    insert into onchain_invoices (id, subscription_id, member_id, period_start, period_end, due_at, base_amount_cents, amount_cents, amount_usdc_micros)
      values (801, 50, 7, now() - interval '20 days', now() + interval '10 days', now() - interval '20 days', 25000, 25000, 250000000);`);
  if (actor) {
    await db.sql("insert into members (id, name, member_type, is_admin, disabled, supabase_user_id) values (1, 'Ada Admin', 'hot_desk', $1, $2, $3)",
      [actor.is_admin, actor.disabled, ACTOR]);
  }
  const session = { from: db.from, auth: { getUser: async () => ({ data: { user: actor ? { id: ACTOR, email: "ada@example.test" } : null } }) } };
  vi.mocked(createClient).mockResolvedValue(session as never);
  vi.mocked(createServiceClient).mockReturnValue(db as never);
}

function call(body: unknown) {
  return POST(
    new Request("http://localhost/api/admin/members/7/cancel-membership", { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "7" }) },
  );
}

const one = async (text: string) => (await db.sql(text))[0];

beforeEach(async () => {
  vi.clearAllMocks();
  db = await makePgDb();
  vi.mocked(clearUserCode).mockImplementation((slot) =>
    clearSlotSafely(slot, async () => [{ entity: "lock.front_door_lock", ok: true }], ["lock.front_door_lock"]));
});
afterEach(() => db.close());

describe("POST /api/admin/members/[id]/cancel-membership", () => {
  it.each([
    ["logged out", null, 401],
    ["a non-admin", { is_admin: false, disabled: false }, 403],
    ["a disabled admin", { is_admin: true, disabled: true }, 403],
  ] as const)("refuses %s before any service-role read", async (_label, actor, status) => {
    await world(actor);
    const res = await call({ mode: "now", void_open_invoices: true });
    expect(res.status).toBe(status);
    expect(createServiceClient).not.toHaveBeenCalled();
    expect((await one("select status, admin_cancel_mode from subscriptions")).admin_cancel_mode).toBeNull();
    expect((await one("select status from onchain_invoices")).status).toBe("open");
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("rejects an unknown mode", async () => {
    await world({ is_admin: true, disabled: false });
    expect((await call({ mode: "yesterday" })).status).toBe(400);
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("an active admin cancels now, voids invoices and is named in the audit row with the reason", async () => {
    await world({ is_admin: true, disabled: false });
    const res = await call({ mode: "now", reason: "  Hasn't been in since July  ", void_open_invoices: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "canceled", rail: "onchain", voidedInvoiceIds: ["801"] });
    expect((await one("select status from subscriptions")).status).toBe("canceled");
    expect((await one("select status from onchain_invoices")).status).toBe("void");
    expect(await one("select member_type, pin_code_slot from members where id = 7")).toEqual({ member_type: "day_pass", pin_code_slot: null });
    expect(await db.sql("select actor_member_id, action, target_id, payload from admin_actions")).toEqual([expect.objectContaining({
      actor_member_id: 1,
      action: "subscription_canceled_by_admin",
      target_id: "7",
      payload: expect.objectContaining({ reason: "Hasn't been in since July", rail: "onchain", mode: "now", voided_invoice_ids: ["801"] }),
    })]);

    const again = await call({ mode: "now" });
    expect(again.status).toBe(200);
    expect((await again.json()).outcome).toBe("already_canceled");
    expect(await db.sql("select id from admin_actions")).toHaveLength(1);
  });
});
