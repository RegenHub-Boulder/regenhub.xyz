import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "../../../../../../test/mockSupabase";

vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { GET } from "./route";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";

const ADMIN_USER = { id: "admin-1", email: "admin@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/members/stale-links", () => {
  it("returns 403 when the caller isn't an admin", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(null as never);

    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns the stale members from find_stale_member_links", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    const staleRows = [
      {
        member_id: 7,
        email: "ben@example.com",
        name: "Benjamin Life",
        supabase_user_id: "11111111-1111-1111-1111-111111111111",
        has_did: true,
      },
    ];
    vi.mocked(createServiceClient).mockReturnValue(
      makeSupabaseMock({
        rpcs: { find_stale_member_links: { data: staleRows } },
      }) as never,
    );

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.members).toEqual(staleRows);
  });

  it("returns an empty list when nothing is stale", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    vi.mocked(createServiceClient).mockReturnValue(
      makeSupabaseMock({ rpcs: { find_stale_member_links: { data: [] } } }) as never,
    );

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.members).toEqual([]);
  });

  it("returns 500 when the RPC errors", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    vi.mocked(createServiceClient).mockReturnValue(
      makeSupabaseMock({
        rpcs: { find_stale_member_links: { error: { message: "function not found" } } },
      }) as never,
    );

    const res = await GET();
    expect(res.status).toBe(500);
  });
});
