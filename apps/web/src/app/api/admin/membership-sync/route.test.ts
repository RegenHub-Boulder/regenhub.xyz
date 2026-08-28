import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseMock } from "../../../../../test/mockSupabase";

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

import { POST } from "./route";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { fetchRegenosIdentity, fetchRegenosSceneStanding } from "@/lib/regenos/auth";

const ADMIN_USER = { id: "admin-1", email: "admin@example.com" };
const STEWARD_DID = "did:plc:steward";

/**
 * Only the tracking-column write introduced alongside migration 051 is
 * covered here (this route had no test file before this change — see the
 * PR notes for why a full suite wasn't added from scratch). Every other
 * `.from("members")` call in the route is a plain select, so this wrapper
 * only needs to intercept `.update(...)` and record its payload.
 */
function makeAdminClient(opts: { members: Record<string, unknown>[] }) {
  const updates: { table: string; payload: unknown; id: unknown }[] = [];
  const base = makeSupabaseMock({
    selects: {
      members: { data: opts.members },
      subscriptions: { data: [] },
    },
  });
  const innerFrom = base.from;
  const from = vi.fn((table: string) => {
    const builder = innerFrom(table) as Record<string, unknown>;
    builder.update = vi.fn((payload: unknown) => {
      const chain: Record<string, unknown> = {
        eq: vi.fn((_col: string, id: unknown) => {
          updates.push({ table, payload, id });
          return Promise.resolve({ data: null, error: null });
        }),
      };
      return chain;
    });
    return builder;
  });
  return { ...base, from, __updates: updates };
}

const upstream = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
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
  vi.stubGlobal("fetch", upstream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/admin/membership-sync — tracking-column write", () => {
  it("records regenos_synced_role/regenos_synced_at after a successful set", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const admin = makeAdminClient({
      members: [
        {
          id: 1,
          name: "Hot Desk Hank",
          did: "did:plc:hank",
          disabled: false,
          is_admin: false,
          is_ops_admin: false,
          member_type: "hot_desk",
        },
      ],
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.synced).toBe(1);
    expect(admin.__updates).toEqual([
      {
        table: "members",
        payload: expect.objectContaining({ regenos_synced_role: "member" }),
        id: 1,
      },
    ]);
  });

  it("records a null synced role after a successful revoke", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const admin = makeAdminClient({
      members: [
        {
          id: 2,
          name: "Disabled Dana",
          did: "did:plc:dana",
          disabled: true,
          is_admin: false,
          is_ops_admin: false,
          member_type: "hub_friend",
        },
      ],
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST();
    await res.json();

    expect(admin.__updates).toEqual([
      {
        table: "members",
        payload: expect.objectContaining({ regenos_synced_role: null }),
        id: 2,
      },
    ]);
  });

  it("records a null synced role when revoke 404s (already absent)", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    const admin = makeAdminClient({
      members: [
        {
          id: 3,
          name: "Already Gone Gary",
          did: "did:plc:gary",
          disabled: true,
          is_admin: false,
          is_ops_admin: false,
          member_type: "hub_friend",
        },
      ],
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST();
    const json = await res.json();

    expect(json.synced).toBe(1);
    expect(admin.__updates).toEqual([
      {
        table: "members",
        payload: expect.objectContaining({ regenos_synced_role: null }),
        id: 3,
      },
    ]);
  });

  it("does not touch the tracking columns when the regenOS call fails", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const admin = makeAdminClient({
      members: [
        {
          id: 4,
          name: "Flaky Fran",
          did: "did:plc:fran",
          disabled: false,
          is_admin: false,
          is_ops_admin: false,
          member_type: "hot_desk",
        },
      ],
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST();
    const json = await res.json();

    expect(json.failed).toBe(1);
    expect(admin.__updates).toEqual([]);
  });
});
