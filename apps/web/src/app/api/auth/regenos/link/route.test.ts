import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "../../../../../../test/mockSupabase";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/regenos/config", () => ({
  isRegenosLoginEnabled: vi.fn(() => true),
}));

vi.mock("@/lib/regenos/auth", () => ({
  fetchRegenosIdentity: vi.fn(),
}));

import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";
import { fetchRegenosIdentity } from "@/lib/regenos/auth";

const DID = "did:plc:byodaccount";
const USER = { id: "user-1", email: "member@example.com" };

function req() {
  return new Request("http://localhost:3000/api/auth/regenos/link", {
    method: "POST",
    headers: { cookie: "__Host-rs_session=opaque" },
  });
}

function makeAdmin(opts: {
  member?: Record<string, unknown> | null;
  updateError?: { code?: string; message: string } | null;
} = {}) {
  const updates: { table: string; payload: unknown }[] = [];
  const base = makeSupabaseMock({
    selects: { members: { data: opts.member ?? null } },
    mutations: { error: opts.updateError ?? null },
  });
  const updateResult = { data: null, error: opts.updateError ?? null };
  const innerFrom = base.from;
  const from = vi.fn((table: string) => {
    const builder = innerFrom(table) as Record<string, unknown>;
    builder.update = vi.fn((payload: unknown) => {
      updates.push({ table, payload });
      const chain: Record<string, unknown> = {
        eq: vi.fn(() => chain),
        then: (onfulfilled?: (v: typeof updateResult) => unknown) =>
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
  vi.mocked(isRegenosLoginEnabled).mockReturnValue(true);
  vi.mocked(fetchRegenosIdentity).mockResolvedValue({
    did: DID,
    handle: "byod.test",
    email: null,
  });
  vi.mocked(createClient).mockResolvedValue(
    makeSupabaseMock({ auth: { user: USER } }) as never,
  );
});

describe("POST /api/auth/regenos/link", () => {
  it("404s when the feature flag is off", async () => {
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(404);
  });

  it("401s when there is no RegenHub session", async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabaseMock({ auth: { user: null } }) as never,
    );
    const res = await POST(req());
    expect(res.status).toBe(401);
  });

  it("401s when there is no regenOS session", async () => {
    vi.mocked(fetchRegenosIdentity).mockResolvedValue(null);
    const res = await POST(req());
    const json = await res.json();
    expect(res.status).toBe(401);
    expect(json.error).toMatch(/No regenOS session/);
  });

  it("403s when the caller is not a member", async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeAdmin({ member: null }) as never);
    const res = await POST(req());
    expect(res.status).toBe(403);
  });

  it("writes members.did for a logged-in member with a live regenOS session and no prior DID", async () => {
    const admin = makeAdmin({ member: { id: 42, email: USER.email, did: null } });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, did: DID, already: false });
    expect(admin.__updates).toEqual([{ table: "members", payload: { did: DID } }]);
  });

  it("is a no-op when the DID is already linked to this member", async () => {
    const admin = makeAdmin({ member: { id: 42, email: USER.email, did: DID } });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.already).toBe(true);
    expect(admin.__updates).toEqual([]);
  });

  it("409s when this membership is already linked to a different DID", async () => {
    const admin = makeAdmin({
      member: { id: 42, email: USER.email, did: "did:plc:someoneelse" },
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(admin.__updates).toEqual([]);
  });

  it("409s when another member already holds this DID", async () => {
    const admin = makeAdmin({
      member: { id: 42, email: USER.email, did: null },
      updateError: { code: "23505", message: "duplicate key" },
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST(req());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toMatch(/already linked to another member/);
  });
});
