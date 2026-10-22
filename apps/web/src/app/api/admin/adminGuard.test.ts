import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseMock } from "../../../../test/mockSupabase";

/**
 * Every admin API route goes through `requireAdmin()` / `requireAdminMember()`
 * in lib/admin.ts — so a signed-out caller, a non-admin and a *disabled*
 * admin are all refused before any service-role client, Stripe call or
 * email. The route list is read from disk, so a new route is covered the
 * day it lands.
 *
 * The Supabase session client is faked (no database in tests); the guard
 * itself is the real code.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

const API = join(__dirname, "..");
// Admin-only routes: everything under /api/admin, plus the one that lives
// outside it.
const ADMIN_ROUTES = [...routeFiles(__dirname), join(API, "lock/revoke/route.ts")]
  .map((f) => relative(API, f))
  .sort();

const USER = { id: "auth-user-1", email: "admin@example.test" };
const SESSIONS = {
  "signed out": { user: null, member: null },
  "non-admin": { user: USER, member: { id: 7, name: "Pat", is_admin: false, disabled: false } },
  "disabled admin": { user: USER, member: { id: 7, name: "Pat", is_admin: true, disabled: true } },
  "admin with no member row": { user: USER, member: null },
};

function signInAs(s: { user: typeof USER | null; member: object | null }) {
  const session = makeSupabaseMock({ auth: { user: s.user }, selects: { members: { data: s.member } } });
  vi.mocked(createClient).mockResolvedValue(session as never);
  return session;
}

function request(method: string): Request {
  return new Request("http://localhost/api/admin/x", {
    method,
    ...(method === "GET" ? {} : { body: "{}", headers: { "content-type": "application/json" } }),
  });
}

const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  vi.mocked(createServiceClient).mockReturnValue(makeSupabaseMock() as never);
  // Stripe "configured" so routes that check it don't short-circuit before
  // the guard would run; any real Stripe call goes through the stubbed fetch.
  process.env.STRIPE_SECRET_KEY = "sk_test_guard";
  delete process.env.CRON_SECRET;
  // regenOS on, so the membership-sync routes reach their guard instead of
  // 404ing on the feature flag.
  process.env.REGENOS_LOGIN_ENABLED = "true";
  process.env.REGENOS_BASE_URL = "https://appview.test";
  process.env.REGENOS_COLLECTIVE_DID = "did:plc:collective";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

it("finds the admin routes", () => {
  expect(ADMIN_ROUTES.length).toBeGreaterThan(30);
});

describe.each(ADMIN_ROUTES)("%s", (file) => {
  let handlers: [string, Handler][] = [];
  beforeAll(async () => {
    const mod = (await import(/* @vite-ignore */ join(API, file))) as Record<string, unknown>;
    handlers = METHODS.filter((m) => typeof mod[m] === "function").map((m) => [m, mod[m] as Handler]);
  }, 120_000); // a cold import of a heavy route is slow on a loaded machine

  it("exports at least one handler", () => {
    expect(handlers.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(SESSIONS))("refuses a %s caller before any privileged work", async (_label, s) => {
    for (const [method, handler] of handlers) {
      vi.clearAllMocks();
      signInAs(s);
      const res = await handler(request(method), { params: Promise.resolve({ id: "1" }) });
      expect([401, 403], `${method} ${file}`).toContain(res.status);
      expect(createServiceClient, `${method} ${file}`).not.toHaveBeenCalled();
      expect(fetch, `${method} ${file}`).not.toHaveBeenCalled();
    }
  });

  it("lets an active admin past the guard", async () => {
    for (const [method, handler] of handlers) {
      vi.clearAllMocks();
      signInAs({ user: USER, member: { id: 7, name: "Pat", is_admin: true, disabled: false } });
      // Past the guard the route may still fail on the empty test body or
      // the faked backends; what it must not do is answer like the guard.
      const res = await handler(request(method), { params: Promise.resolve({ id: "1" }) }).catch(() => null);
      if (res) expect(await res.clone().json().catch(() => ({})), `${method} ${file}`).not.toEqual({ error: "Forbidden" });
    }
  });
});

it("no API route checks members.is_admin by hand", () => {
  // `!x?.is_admin` is the shape of a hand-rolled guard; reading is_admin as
  // data (filters, selects, the members editor) is fine.
  const offenders = routeFiles(API)
    .filter((f) => /!\s*\w+\??\.is_admin/.test(readFileSync(f, "utf8")))
    .map((f) => relative(API, f));
  expect(offenders).toEqual([]);
});

it("every admin route imports its guard from lib/admin", () => {
  const unguarded = ADMIN_ROUTES.filter(
    (f) => !/import \{[^}]*\brequireAdmin(Member)?\b[^}]*\} from "@\/lib\/admin"/.test(readFileSync(join(API, f), "utf8")),
  );
  expect(unguarded).toEqual([]);
});

describe("active admin: the guard hands the route the right identity", () => {
  const ADMIN = { id: 42, name: "Robin", is_admin: true, disabled: false };

  it("newsletter/preview sends the preview to the admin's own address", async () => {
    signInAs({ user: USER, member: ADMIN });
    const { POST } = await import("./newsletter/preview/route");
    const res = await POST(new Request("http://localhost/x", {
      method: "POST",
      body: JSON.stringify({ markdown: "# Hello", subject: "Dispatch" }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent_to: USER.email });
  }, 30_000);

  it("digest-note POST records the admin as author", async () => {
    signInAs({ user: USER, member: ADMIN });
    const service = makeSupabaseMock();
    vi.mocked(createServiceClient).mockReturnValue(service as never);
    const { POST } = await import("./digest-note/route");
    const res = await POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ note: "Fridge is fixed" }) }));
    expect(res.status).toBe(200);
    const inserts = service.from.mock.results
      .map((r) => (r.value as { insert: ReturnType<typeof vi.fn> }).insert.mock.calls)
      .flat();
    expect(inserts).toContainEqual([{ note: "Fridge is fixed", author_member_id: 42 }]);
  }, 30_000);

  it("applications PATCH stamps rejected_by with the admin's member id", async () => {
    const session = signInAs({ user: USER, member: ADMIN });
    const { PATCH } = await import("./applications/route");
    const res = await PATCH(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ id: 5, status: "rejected" }) }));
    expect(res.status).toBe(200);
    const updates = session.from.mock.results
      .map((r) => (r.value as { update: ReturnType<typeof vi.fn> }).update.mock.calls)
      .flat();
    expect(updates).toContainEqual([expect.objectContaining({ status: "rejected", rejected_by: 42 })]);
  }, 30_000);
});
