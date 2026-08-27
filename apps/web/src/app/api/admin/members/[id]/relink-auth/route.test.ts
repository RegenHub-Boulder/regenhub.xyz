import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "../../../../../../../test/mockSupabase";

vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { POST } from "./route";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";

const ADMIN_USER = { id: "admin-auth-1", email: "admin@example.com" };
const OLD_AUTH_ID = "dead0000-0000-0000-0000-000000000000";
const NEW_AUTH_ID = "1111aaaa-0000-0000-0000-000000000000";

function req() {
  return new Request("http://localhost/api/admin/members/7/relink-auth", { method: "POST" });
}

const ctx = { params: Promise.resolve({ id: "7" }) };

type UpdateResult = { data: unknown; error: { message: string } | null };

/**
 * The shared mockSupabase helper's `.update(...)` loses the mutation
 * response as soon as you chain `.eq(...)` (its `eq` falls back to the
 * SELECT builder) — this route's whole concurrency-guard path lives on
 * `await …update(…).eq(…).eq(…).select(…)`. Widen it here, as
 * mockSupabase.ts's own docstring invites (same pattern as
 * auth/regenos/link and auth/regenos/session's tests).
 */
function makeAdminMock(opts: {
  member?: Record<string, unknown> | null;
  rpcs?: Record<string, { data?: unknown; error?: { message: string } | null }>;
  updateResult?: UpdateResult;
} = {}) {
  const updates: { table: string; payload: unknown }[] = [];
  const base = makeSupabaseMock({
    selects: { members: { data: opts.member ?? null } },
    rpcs: opts.rpcs,
  });
  const updateResult: UpdateResult = opts.updateResult ?? { data: [{ id: 7 }], error: null };
  const innerFrom = base.from;
  const from = vi.fn((table: string) => {
    const builder = innerFrom(table) as Record<string, unknown>;
    builder.update = vi.fn((payload: unknown) => {
      updates.push({ table, payload });
      const chain: Record<string, unknown> = {
        eq: vi.fn(() => chain),
        is: vi.fn(() => chain),
        select: vi.fn(() => chain),
        then: (onfulfilled?: (v: UpdateResult) => unknown) =>
          Promise.resolve(updateResult).then(onfulfilled),
      };
      return chain;
    });
    return builder;
  });
  return { ...base, from, __updates: updates };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/members/[id]/relink-auth", () => {
  it("returns 403 when the caller isn't an admin", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(null as never);

    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 404 when the member doesn't exist", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    vi.mocked(createServiceClient).mockReturnValue(makeAdminMock({ member: null }) as never);

    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the member's email has no live auth.users identity", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    vi.mocked(createServiceClient).mockReturnValue(
      makeAdminMock({
        member: { id: 7, email: "ben@example.com", supabase_user_id: OLD_AUTH_ID },
        rpcs: { current_auth_user_for_email: { data: null } },
      }) as never,
    );

    const res = await POST(req(), ctx);
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toMatch(/No auth\.users identity/);
  });

  it("is a no-op when already linked to the current identity", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    const admin = makeAdminMock({
      member: { id: 7, email: "ben@example.com", supabase_user_id: NEW_AUTH_ID },
      rpcs: { current_auth_user_for_email: { data: NEW_AUTH_ID } },
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST(req(), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ noop: true });
    expect(admin.__updates).toEqual([]);
  });

  it("relinks supabase_user_id and logs the action on success", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    const admin = makeAdminMock({
      member: { id: 7, email: "ben@example.com", supabase_user_id: OLD_AUTH_ID },
      rpcs: { current_auth_user_for_email: { data: NEW_AUTH_ID } },
      updateResult: { data: [{ id: 7 }], error: null },
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST(req(), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, from: OLD_AUTH_ID, to: NEW_AUTH_ID });
    expect(admin.__updates).toEqual([
      { table: "members", payload: { supabase_user_id: NEW_AUTH_ID } },
    ]);
  });

  it("returns 409 when the auth link changed concurrently", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    const admin = makeAdminMock({
      member: { id: 7, email: "ben@example.com", supabase_user_id: OLD_AUTH_ID },
      rpcs: { current_auth_user_for_email: { data: NEW_AUTH_ID } },
      updateResult: { data: [], error: null },
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
  });
});
