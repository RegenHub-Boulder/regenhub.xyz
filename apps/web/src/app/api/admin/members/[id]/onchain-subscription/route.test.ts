import { beforeEach, expect, it, vi } from "vitest";
import { makeSupabaseMock } from "../../../../../../../test/mockSupabase";
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/onchain/discount", () => ({ resolveOnchainCoupon: vi.fn() }));
vi.mock("@/lib/auditLog", () => ({ AuditAction: { ONCHAIN_SUBSCRIPTION_CHANGED: "onchain_subscription_changed" }, logAction: vi.fn() }));
import { PATCH } from "./route";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { resolveOnchainCoupon } from "@/lib/onchain/discount";
import { logAction } from "@/lib/auditLog";
const ctx = { params: Promise.resolve({ id: "7" }) };
function request(body: object) { return new Request("http://localhost/test", { method: "PATCH", body: JSON.stringify(body) }); }
beforeEach(() => vi.clearAllMocks());
it("rejects non-admin/disabled-admin sessions before service-role reads", async () => {
  vi.mocked(requireAdmin).mockResolvedValue(null);
  expect((await PATCH(request({ plan_key: "member_basic" }), ctx)).status).toBe(403);
  expect(createServiceClient).not.toHaveBeenCalled();
});
it("edits the prospective plan and records an audit event without repricing invoices", async () => {
  vi.mocked(requireAdmin).mockResolvedValue({ id: "admin" } as never);
  const admin = makeSupabaseMock({ selects: { members: { data: { id: 9 } }, subscriptions: { data: { id: 1, plan_key: "cold_desk" } } } });
  vi.mocked(createServiceClient).mockReturnValue(admin as never);
  expect((await PATCH(request({ plan_key: "member_basic" }), ctx)).status).toBe(200);
  expect(admin.from).not.toHaveBeenCalledWith("onchain_invoices");
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ actorMemberId: 9, payload: expect.objectContaining({ plan_key: "member_basic", monthly_cents: 3000 }) }), admin);
});
it("rejects invalid codes without updating the subscription", async () => {
  vi.mocked(requireAdmin).mockResolvedValue({ id: "admin" } as never);
  const admin = makeSupabaseMock({ selects: { members: { data: { id: 9 } }, subscriptions: { data: { id: 1, plan_key: "cold_desk" } } } });
  vi.mocked(createServiceClient).mockReturnValue(admin as never);
  vi.mocked(resolveOnchainCoupon).mockRejectedValue(new Error("Invalid code"));
  expect((await PATCH(request({ discount_code: "NOPE" }), ctx)).status).toBe(400);
  expect(logAction).not.toHaveBeenCalled();
});
