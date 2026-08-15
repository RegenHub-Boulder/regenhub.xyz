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

const DID = "did:plc:regenhubmember";
const EMAIL = "member@example.com";
const HASHED_TOKEN = "hashed-token-abc";

/** A request carrying the regenOS session cookie the route reads off the browser. */
function req() {
  return new Request("http://localhost:3000/api/auth/regenos/session", {
    method: "POST",
    headers: { cookie: "__Host-rs_session=opaque" },
  });
}

type AdminMockOpts = {
  member?: Record<string, unknown> | null;
  /** Error the members UPDATE should return (e.g. a 23505 unique violation). */
  updateError?: { code?: string; message: string } | null;
  /** Make the first generateLink fail, so the route takes the provisioning path. */
  generateLinkFailsUntilCreate?: boolean;
  /** What GoTrue says it minted — `signup` when it auto-created the user. */
  verificationType?: "magiclink" | "signup";
};

/**
 * The service-role client, plus the admin auth surface this route uses
 * (`auth.admin.generateLink` / `auth.admin.createUser`) which the shared
 * mockSupabase helper doesn't model. Also records every `.update()` payload so
 * a test can assert the DID write actually happened.
 */
function makeAdminMock(opts: AdminMockOpts = {}) {
  const updates: { table: string; payload: unknown }[] = [];

  const base = makeSupabaseMock({
    selects: { members: { data: opts.member ?? null } },
    mutations: { error: opts.updateError ?? null },
  });

  // The shared helper's `.update(...)` loses the mutation response as soon as
  // you chain `.eq(...)` (its `eq` falls back to the SELECT builder), and this
  // route's whole 23505 path lives on `await …update(…).eq(…)`. Widen it here,
  // as mockSupabase.ts's own docstring invites.
  const updateResult = { data: null, error: opts.updateError ?? null };
  const innerFrom = base.from;
  const from = vi.fn((table: string) => {
    const builder = innerFrom(table) as Record<string, unknown>;
    builder.update = vi.fn((payload: unknown) => {
      updates.push({ table, payload });
      const chain: Record<string, unknown> = {
        eq: vi.fn(() => chain),
        is: vi.fn(() => chain),
        select: vi.fn(() => chain),
        single: vi.fn(async () => updateResult),
        then: (onfulfilled?: (v: typeof updateResult) => unknown) =>
          Promise.resolve(updateResult).then(onfulfilled),
      };
      return chain;
    });
    return builder;
  });

  let created = false;
  const generateLink = vi.fn(async () => {
    if (opts.generateLinkFailsUntilCreate && !created) {
      return { data: null, error: { message: "User not found" } };
    }
    return {
      data: {
        properties: {
          hashed_token: HASHED_TOKEN,
          verification_type: opts.verificationType ?? "magiclink",
        },
      },
      error: null,
    };
  });
  const createUser = vi.fn(async () => {
    created = true;
    return { data: { user: { id: "auth-1" } }, error: null };
  });

  return {
    ...base,
    from,
    auth: { ...base.auth, admin: { generateLink, createUser } },
    __updates: updates,
    __generateLink: generateLink,
    __createUser: createUser,
  };
}

/** The cookie-bound server client — only `auth.verifyOtp` matters here. */
function makeServerMock(verifyError: { message: string } | null = null) {
  const base = makeSupabaseMock();
  const verifyOtp = vi.fn(async () => ({ data: {}, error: verifyError }));
  return { ...base, auth: { ...base.auth, verifyOtp }, __verifyOtp: verifyOtp };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isRegenosLoginEnabled).mockReturnValue(true);
  vi.mocked(fetchRegenosIdentity).mockResolvedValue({ did: DID, handle: "member.test", email: EMAIL });
});

describe("POST /api/auth/regenos/session", () => {
  it("404s when the feature flag is off", async () => {
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(false);

    const res = await POST(req());

    expect(res.status).toBe(404);
    expect(fetchRegenosIdentity).not.toHaveBeenCalled();
  });

  it("401s when there is no regenOS session", async () => {
    vi.mocked(fetchRegenosIdentity).mockResolvedValue(null);
    vi.mocked(createServiceClient).mockReturnValue(makeAdminMock() as never);

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toMatch(/No regenOS session/);
  });

  it("403s when the regenOS account has no verified email", async () => {
    vi.mocked(fetchRegenosIdentity).mockResolvedValue({ did: DID, handle: null, email: null });
    vi.mocked(createServiceClient).mockReturnValue(makeAdminMock() as never);

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toMatch(/no verified email/);
  });

  it("links the DID and mints a Supabase session for a matched member", async () => {
    const admin = makeAdminMock({ member: { id: 42, email: EMAIL, did: null, disabled: false } });
    const server = makeServerMock();
    vi.mocked(createServiceClient).mockReturnValue(admin as never);
    vi.mocked(createClient).mockResolvedValue(server as never);

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, member: true, did: DID, redirect: "/portal" });

    // The DID landed on the member row — server-side, not via the profile whitelist.
    expect(admin.__updates).toEqual([{ table: "members", payload: { did: DID } }]);

    // And the session was minted without sending a second email.
    expect(admin.__generateLink).toHaveBeenCalledWith({ type: "magiclink", email: EMAIL });
    expect(admin.__createUser).not.toHaveBeenCalled();
    expect(server.__verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: HASHED_TOKEN });
  });

  it("does not rewrite a DID that is already linked to the same identity", async () => {
    const admin = makeAdminMock({ member: { id: 42, email: EMAIL, did: DID, disabled: false } });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);
    vi.mocked(createClient).mockResolvedValue(makeServerMock() as never);

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(admin.__updates).toEqual([]);
  });

  it("409s when the member is already linked to a different regenOS identity", async () => {
    const admin = makeAdminMock({
      member: { id: 42, email: EMAIL, did: "did:plc:someoneelse", disabled: false },
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);
    vi.mocked(createClient).mockResolvedValue(makeServerMock() as never);

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/already linked to a different regenOS identity/);
    expect(admin.__updates).toEqual([]);
    expect(admin.__generateLink).not.toHaveBeenCalled();
  });

  it("409s when the unique index catches a DID already held by another member", async () => {
    const admin = makeAdminMock({
      member: { id: 42, email: EMAIL, did: null, disabled: false },
      updateError: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);
    vi.mocked(createClient).mockResolvedValue(makeServerMock() as never);

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/already linked to another member/);
    expect(admin.__generateLink).not.toHaveBeenCalled();
  });

  it("mints a participant session when no member matches the verified email", async () => {
    const admin = makeAdminMock({ member: null });
    const server = makeServerMock();
    vi.mocked(createServiceClient).mockReturnValue(admin as never);
    vi.mocked(createClient).mockResolvedValue(server as never);

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, member: false, redirect: "/membership" });
    // No member row is created — a participant gets public features only.
    expect(admin.__updates).toEqual([]);
    expect(server.__verifyOtp).toHaveBeenCalled();
  });

  it("provisions the auth.users row when one doesn't exist yet", async () => {
    const admin = makeAdminMock({
      member: { id: 42, email: EMAIL, did: null, disabled: false },
      generateLinkFailsUntilCreate: true,
    });
    const server = makeServerMock();
    vi.mocked(createServiceClient).mockReturnValue(admin as never);
    vi.mocked(createClient).mockResolvedValue(server as never);

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(admin.__createUser).toHaveBeenCalledWith({ email: EMAIL, email_confirm: true });
    expect(admin.__generateLink).toHaveBeenCalledTimes(2);
    expect(server.__verifyOtp).toHaveBeenCalled();
  });

  it("redeems with the verification_type GoTrue minted, not a hardcoded magiclink", async () => {
    // Current GoTrue doesn't 404 generate_link for a missing user — it
    // auto-creates one and mints a `signup` token. Redeeming that as
    // "magiclink" fails, which used to break every new member's first
    // sign-in. The route must pass through what GoTrue actually minted.
    const admin = makeAdminMock({
      member: { id: 42, email: EMAIL, did: null, disabled: false },
      verificationType: "signup",
    });
    const server = makeServerMock();
    vi.mocked(createServiceClient).mockReturnValue(admin as never);
    vi.mocked(createClient).mockResolvedValue(server as never);

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(admin.__createUser).not.toHaveBeenCalled();
    expect(server.__verifyOtp).toHaveBeenCalledWith({
      type: "signup",
      token_hash: HASHED_TOKEN,
    });
  });

  it("500s when the session mint fails", async () => {
    const admin = makeAdminMock({ member: { id: 42, email: EMAIL, did: null, disabled: false } });
    const server = makeServerMock({ message: "token expired" });
    vi.mocked(createServiceClient).mockReturnValue(admin as never);
    vi.mocked(createClient).mockResolvedValue(server as never);

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toMatch(/Couldn't start your session/);
  });
});
