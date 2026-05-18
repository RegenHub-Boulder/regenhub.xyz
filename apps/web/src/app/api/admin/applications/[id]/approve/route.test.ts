import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "../../../../../../../test/mockSupabase";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe")>("@/lib/stripe");
  return {
    ...actual,
    isStripeConfigured: vi.fn(() => true),
    createApprovalCheckoutSession: vi.fn(),
  };
});

import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/applications/1/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "1" }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/applications/[id]/approve", () => {
  it("returns 401 when no auth user", async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabaseMock({ auth: { user: null } }) as never,
    );

    const res = await POST(makeRequest({ plan_key: "cold_desk", monthly_cents: 50000 }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not an admin", async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabaseMock({
        auth: { user: { id: "u-1", email: "a@b.co" } },
        selects: { members: { data: { is_admin: false } } },
      }) as never,
    );

    const res = await POST(makeRequest({ plan_key: "cold_desk", monthly_cents: 50000 }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when plan_key is unknown", async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabaseMock({
        auth: { user: { id: "u-1", email: "a@b.co" } },
        selects: { members: { data: { is_admin: true } } },
      }) as never,
    );

    const res = await POST(makeRequest({ plan_key: "bogus", monthly_cents: 50000 }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when monthly_cents is missing or sub-dollar", async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabaseMock({
        auth: { user: { id: "u-1", email: "a@b.co" } },
        selects: { members: { data: { is_admin: true } } },
      }) as never,
    );

    const res = await POST(makeRequest({ plan_key: "cold_desk", monthly_cents: 50 }), ctx);
    expect(res.status).toBe(400);
  });
});
