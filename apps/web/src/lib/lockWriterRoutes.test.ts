import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseMock } from "../../test/mockSupabase";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn(), isStripeConfigured: () => false }));

const routes = [
  { name: "admin lock sync", load: () => import("../app/api/admin/lock-sync/route"), admin: true },
  { name: "admin quarantine", load: () => import("../app/api/admin/lock-quarantine/route"), admin: true },
  { name: "admin quickcode", load: () => import("../app/api/admin/quickcode/route"), admin: true },
  { name: "admin members", load: () => import("../app/api/admin/members/route"), admin: true },
  { name: "admin member revoke", load: () => import("../app/api/admin/members/[id]/revoke/route"), admin: true },
  { name: "admin member PATCH", load: async () => ({ POST: (await import("../app/api/admin/members/[id]/route")).PATCH }), admin: true },
  { name: "admin member DELETE", load: async () => ({ POST: (await import("../app/api/admin/members/[id]/route")).DELETE }), admin: true },
  { name: "lock revoke", load: () => import("../app/api/lock/revoke/route"), admin: true },
  { name: "portal revoke", load: () => import("../app/api/portal/revoke-code/route"), admin: false },
  { name: "portal request daypass", load: () => import("../app/api/portal/request-daypass/route"), admin: false },
  { name: "portal regenerate", load: () => import("../app/api/portal/regenerate-code/route"), admin: false },
  { name: "free day activate", load: () => import("../app/api/freeday/activate/route"), admin: false },
];

beforeEach(() => vi.clearAllMocks());
describe.each(routes)("$name authorization before reservation", ({ load, admin }) => {
  for (const authenticated of admin ? [false, true] : [false]) {
    it(`${authenticated ? "non-admin" : "unauthenticated"} request never acquires`, async () => {
      const session = makeSupabaseMock({
        auth: { user: authenticated ? { id: "regular-user", email: "member@example.test" } : null },
        selects: { members: { data: { is_admin: false, disabled: false } } },
      });
      const service = makeSupabaseMock();
      vi.mocked(createClient).mockResolvedValue(session as never);
      vi.mocked(createServiceClient).mockReturnValue(service as never);
      const route = await load();
      const handler = route.POST as (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
      const response = await handler(new Request("http://localhost/test", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "1" }) });
      expect([401, 403]).toContain(response.status);
      expect(service.rpc).not.toHaveBeenCalled();
      expect(session.rpc).not.toHaveBeenCalled();
    });
  }
});

it.each([
  { load: () => import("../app/api/admin/members/route"), body: {}, id: "1" },
  { load: () => import("../app/api/admin/lock-quarantine/route"), body: { slot: 201 }, id: "1" },
  { load: () => import("../app/api/portal/regenerate-code/route"), body: { code: "invalid" }, id: "1" },
  { load: () => import("../app/api/admin/members/[id]/revoke/route"), body: {}, id: "invalid" },
])("pure invalid input never acquires ($id, $body)", async ({ load, body, id }) => {
  const session = makeSupabaseMock({ auth: { user: { id: "admin", email: "admin@example.test" } }, selects: { members: { data: { is_admin: true, disabled: false } } } });
  const service = makeSupabaseMock();
  vi.mocked(createClient).mockResolvedValue(session as never);
  vi.mocked(createServiceClient).mockReturnValue(service as never);
  const route = await load();
  const handler = route.POST as (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  expect((await handler(new Request("http://localhost/test", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })).status).toBe(400);
  expect(service.rpc).not.toHaveBeenCalled();
});
