import { beforeEach, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { makeSupabaseMock } from "../../test/mockSupabase";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ isStripeConfigured: () => false, getStripe: vi.fn() }));
vi.mock("@/lib/onchain/invoice", () => ({ discountedCents: (n: number) => n, generateUpcomingOnchainInvoices: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/auditLog", () => ({ AuditAction: {}, logAction: vi.fn() }));

const handlers = [
  { name: "application status PATCH", load: async () => (await import("../app/api/admin/applications/route")).PATCH },
  { name: "onchain subscription POST", load: async () => (await import("../app/api/admin/members/[id]/onchain-subscription/route")).POST },
  { name: "application approve POST", load: async () => (await import("../app/api/admin/applications/[id]/approve/route")).POST },
  { name: "checkout email POST", load: async () => (await import("../app/api/admin/applications/[id]/send-checkout-email/route")).POST },
  { name: "communications POST", load: async () => (await import("../app/api/admin/communications/route")).POST },
  { name: "digest GET", load: async () => (await import("../app/api/admin/digest-note/route")).GET },
  { name: "digest POST", load: async () => (await import("../app/api/admin/digest-note/route")).POST },
  { name: "apply credit POST", load: async () => (await import("../app/api/admin/members/[id]/apply-credit/route")).POST },
  { name: "approve membership PATCH", load: async () => (await import("../app/api/admin/members/[id]/approve-membership/route")).PATCH },
  { name: "newsletter preview POST", load: async () => (await import("../app/api/admin/newsletter-preview/route")).POST },
];
beforeEach(() => vi.clearAllMocks());
for (const { name, load } of handlers) {
  it.each(["unauthenticated", "non-admin", "disabled-admin"])(`${name} denies %s before privileged access`, async (state) => {
    const actor = { id: 7, is_admin: state === "disabled-admin", disabled: state === "disabled-admin" };
    const session = makeSupabaseMock({ auth: { user: state === "unauthenticated" ? null : { id: "actor", email: "actor@example.test" } }, selects: { members: { data: actor } } });
    const service = makeSupabaseMock({ selects: { members: { data: actor } } });
    vi.mocked(createClient).mockResolvedValue(session as never);
    vi.mocked(createServiceClient).mockReturnValue(service as never);
    const handler = await load();
    const response = await handler(new Request("http://localhost/test", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "1" }) });
    expect([401, 403]).toContain(response.status);
    expect(createServiceClient).not.toHaveBeenCalled();
    // No table access also rules out SELECTs and INSERTs.
    expect(service.from).not.toHaveBeenCalled();
    expect(service.rpc).not.toHaveBeenCalled();
    expect((await import("@/lib/auditLog")).logAction).not.toHaveBeenCalled();
  });
}

it("active admin creates an onchain subscription and acquires/releases the real writer", async () => {
  const session = makeSupabaseMock({ auth: { user: { id: "actor", email: "actor@example.test" } }, selects: { members: { data: { id: 7, is_admin: true, disabled: false } } } });
  const service = makeSupabaseMock({ selects: { members: { data: { id: 7, is_admin: true, pin_code_slot: null, disabled: true } } }, rpcs: { bind_member_wallet: { data: 9 } } });
  const insert = vi.fn();
  const from = service.from.getMockImplementation()!;
  service.from.mockImplementation((table) => {
    const builder = from(table);
    if (table === "subscriptions") {
      builder.insert = insert.mockReturnValue({ select: () => ({ single: async () => ({ data: { id: 11 }, error: null }) }) });
    }
    return builder;
  });
  vi.mocked(createClient).mockResolvedValue(session as never);
  vi.mocked(createServiceClient).mockReturnValue(service as never);
  const { POST } = await import("../app/api/admin/members/[id]/onchain-subscription/route");
  const response = await POST(new Request("http://localhost/test", { method: "POST", body: JSON.stringify({ plan_key: "hot_desk", monthly_cents: 25000, wallet_address: "0x0000000000000000000000000000000000000001", paid_through: "2099-01-01" }) }), { params: Promise.resolve({ id: "1" }) });
  expect(response.status).toBe(200);
  expect(insert).toHaveBeenCalledOnce();
  expect(service.rpc.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining(["bind_member_wallet", "acquire_lock_writer", "release_lock_writer"]));
  expect(service.rpc).toHaveBeenCalledWith("bind_member_wallet", expect.objectContaining({ p_verified_by: 7 }));
});
