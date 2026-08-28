import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "../../../../../../../test/mockSupabase";

vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/regenos/config", () => ({
  isRegenosLoginEnabled: vi.fn(() => true),
  regenosBaseUrl: vi.fn(() => "https://appview.test"),
  regenosCollectiveDid: vi.fn(() => "did:plc:collective"),
}));
vi.mock("@/lib/regenos/auth", () => ({
  fetchRegenosIdentity: vi.fn(),
  fetchRegenosSceneStanding: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ toString: () => "__Host-rs_session=opaque" })),
}));

import { GET } from "./route";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { isRegenosLoginEnabled, regenosBaseUrl, regenosCollectiveDid } from "@/lib/regenos/config";
import { fetchRegenosIdentity, fetchRegenosSceneStanding } from "@/lib/regenos/auth";

const ADMIN_USER = { id: "admin-1", email: "admin@example.com" };
const STEWARD_DID = "did:plc:steward";

function makeAdminClient(opts: {
  members?: Record<string, unknown>[];
  subs?: { member_id: number }[];
}) {
  const base = makeSupabaseMock({
    selects: {
      members: { data: opts.members ?? [] },
      subscriptions: { data: opts.subs ?? [] },
    },
  });
  return base;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isRegenosLoginEnabled).mockReturnValue(true);
  vi.mocked(regenosBaseUrl).mockReturnValue("https://appview.test");
  vi.mocked(regenosCollectiveDid).mockReturnValue("did:plc:collective");
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
  vi.mocked(fetchRegenosIdentity).mockResolvedValue({
    did: STEWARD_DID,
    handle: "steward.test",
    email: "steward@example.com",
  });
  vi.mocked(fetchRegenosSceneStanding).mockResolvedValue({
    role: "steward",
    steward: true,
    canManageEvents: true,
  });
});

describe("GET /api/admin/membership-sync/preview", () => {
  it("returns 403 when the caller isn't a RegenHub admin", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(null as never);

    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns 401 when there is no regenOS session", async () => {
    vi.mocked(fetchRegenosIdentity).mockResolvedValue(null);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(401);
    expect(json.error).toMatch(/Sign in with regenOS/);
  });

  it("returns 403 when the caller is not a regenOS steward", async () => {
    vi.mocked(fetchRegenosSceneStanding).mockResolvedValue({
      role: "member",
      steward: false,
      canManageEvents: false,
    });

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toMatch(/steward/);
  });

  it("returns an empty pending list when every member's synced role already matches its plan", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeAdminClient({
        members: [
          {
            id: 1,
            name: "Cold Desk Carla",
            did: "did:plc:carla",
            disabled: false,
            is_admin: false,
            is_ops_admin: false,
            member_type: "cold_desk",
            regenos_synced_role: "member",
          },
          {
            id: 2,
            name: "Admin Amy",
            did: "did:plc:amy",
            disabled: false,
            is_admin: true,
            is_ops_admin: false,
            member_type: "day_pass",
            regenos_synced_role: "steward",
          },
        ],
        subs: [],
      }) as never,
    );

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.pending).toEqual([]);
    expect(json.upToDateCount).toBe(2);
  });

  it("lists members whose current plan disagrees with their last-synced role — set and revoke cases", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeAdminClient({
        members: [
          // Never synced (null), plan says set → member. Pending "set".
          {
            id: 3,
            name: "Hot Desk Hank",
            did: "did:plc:hank",
            disabled: false,
            is_admin: false,
            is_ops_admin: false,
            member_type: "hot_desk",
            regenos_synced_role: null,
          },
          // Synced as member, now disabled → plan says revoke. Pending "revoke".
          {
            id: 4,
            name: "Disabled Dana",
            did: "did:plc:dana",
            disabled: true,
            is_admin: false,
            is_ops_admin: false,
            member_type: "hub_friend",
            regenos_synced_role: "member",
          },
          // Already up to date: synced null, plan is day_pass w/o sub → revoke target null.
          {
            id: 5,
            name: "Day Pass Dee",
            did: "did:plc:dee",
            disabled: false,
            is_admin: false,
            is_ops_admin: false,
            member_type: "day_pass",
            regenos_synced_role: null,
          },
        ],
        subs: [],
      }) as never,
    );

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.upToDateCount).toBe(1);
    expect(json.pending).toEqual([
      {
        member_id: 3,
        name: "Hot Desk Hank",
        current_synced_role: null,
        target_action: "set",
        target_role: "member",
      },
      {
        member_id: 4,
        name: "Disabled Dana",
        current_synced_role: "member",
        target_action: "revoke",
        target_role: null,
      },
    ]);
  });
});
