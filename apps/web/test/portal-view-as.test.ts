/**
 * "View the portal as…" (T-482, lib/viewAs.ts). Against a real Postgres (PGlite, every migration applied) and the real
 * pages, routes and proxy:
 *   - only an active admin can enter; a non-admin, a disabled admin and a signed-out caller can't, and a cookie
 *     alone (forged, someone else's, or an admin since disabled) shows nothing;
 *   - every kind of member renders its key sections, with sample people and the placeholder code, never the
 *     admin's own data, and every control disabled;
 *   - one real member's portal shows with their codes masked, and each view is audited;
 *   - every write path is refused while a preview cookie is set: all POST/PUT/PATCH/DELETE route handlers (read from
 *     disk, so a new one is covered the day it lands), a server action's page post, and the GETs that write.
 * Faked: only the signed-in session, the cookie jar and the network edge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import { makePgDb, type PgDb } from "./pgDb";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const browser = vi.hoisted(() => ({ cookies: new Map<string, string>(), path: "/portal" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (browser.cookies.has(name) ? { name, value: browser.cookies.get(name)! } : undefined),
    getAll: () => [...browser.cookies].map(([name, value]) => ({ name, value })),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers({ "x-pathname": browser.path }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {}, replace() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import PortalPage from "@/app/portal/page";
import PortalLayout from "@/app/portal/layout";
import { POST as enterPOST } from "@/app/api/admin/view-as/route";
import { proxy } from "@/proxy";
import { PORTAL_FIXTURES } from "@/lib/portalFixtures";
import { PLACEHOLDER_CODE } from "@/lib/portalHome";
import { PREVIEW_INVITE_URL } from "@/components/portal/InviteCard";
import { VIEW_AS_COOKIE, viewAsCookieValue, viewAsRefuses } from "@/lib/viewAs";

const ADMIN = "00000000-0000-4000-8000-00000000000a";
const OFF = "00000000-0000-4000-8000-00000000000d"; // an admin who has been disabled
const ANA = "00000000-0000-4000-8000-0000000000a2"; // a member, not an admin
const WRITER = "00000000-0000-4000-8000-000000000482";
const SITE = "https://preview.test";
/** The admin's own door code and the real member's: neither may ever reach a preview. */
const ADMIN_PIN = "204611";
const ANA_PIN = "583027";
const ANA_DAY_CODE = "771204";

let db: PgDb;

async function world() {
  db = await makePgDb();
  await db.exec(`select acquire_lock_writer('${WRITER}');
    select set_config('request.headers', '{"x-lock-writer-token":"${WRITER}"}', false);
    insert into auth.users (id, email) values ('${ADMIN}', 'robin@example.test'), ('${OFF}', 'off@example.test'), ('${ANA}', 'ana@example.test');
    insert into members (id, name, email, member_type, is_admin, disabled, is_coop_member, supabase_user_id, pin_code, pin_code_slot, day_passes_balance, created_at) values
      (1, 'Robin Admin', 'robin@example.test', 'cold_desk', true, false, true, '${ADMIN}', '${ADMIN_PIN}', 1, 7, now() - interval '700 days'),
      (2, 'Ana Sample', 'ana@example.test', 'hot_desk', false, false, true, '${ANA}', '${ANA_PIN}', 2, 3, now() - interval '300 days'),
      (3, 'Off Admin', 'off@example.test', 'hot_desk', true, true, false, '${OFF}', null, null, 0, now() - interval '300 days'),
      (4, 'Dee Daypass', 'dee@example.test', 'day_pass', false, false, false, null, null, null, 1, now() - interval '20 days');
    insert into subscriptions (member_id, plan_key, monthly_cents, net_cents, status, current_period_end,
        stripe_subscription_id, stripe_customer_id, stripe_price_id) values
      (1, 'cold_desk', 50000, 50000, 'active', now() + interval '18 days', 'sub_1', 'cus_1', 'price_x'),
      (2, 'hot_desk', 25000, 25000, 'active', now() + interval '18 days', 'sub_2', 'cus_2', 'price_x');
    insert into day_codes (member_id, code, pin_slot, label, is_active, expires_at) values
      (4, '${ANA_DAY_CODE}', 130, 'day', true, now() + interval '3 hours');
    select set_config('request.headers', '{}', false); select release_lock_writer('${WRITER}');`);
  vi.mocked(createServiceClient).mockReturnValue(db as never);
}

function signIn(userId: string | null, email = "x@example.test") {
  vi.mocked(createClient).mockResolvedValue({
    from: db.from,
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId, email } : null } }) },
  } as never);
}

function viewAs(target: Parameters<typeof viewAsCookieValue>[0], adminUserId = ADMIN) {
  browser.cookies.set(VIEW_AS_COOKIE, viewAsCookieValue(target, adminUserId, Date.now()));
}

const html = async (node: unknown) => {
  const stream = await renderToReadableStream((await node) as never);
  await stream.allReady;
  return new Response(stream).text();
};

const enter = (body: Record<string, string>) =>
  enterPOST(new Request(`${SITE}/api/admin/view-as`, { method: "POST", headers: { origin: SITE }, body: new URLSearchParams(body) }));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("REGENOS_BASE_URL", "");
  vi.stubEnv("TECHNE_SIGNIN_ENABLED", "");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  browser.cookies.clear();
  browser.path = "/portal";
  await world();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.close();
});

describe("who can enter", () => {
  it.each([
    ["signed out", null],
    ["a member who isn't an admin", ANA],
    ["a disabled admin", OFF],
  ])("%s can't", async (_label, user) => {
    signIn(user);
    const res = await enter({ fixture: "hot-desk" });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("an active admin can, and lands on /portal with a short-lived httpOnly cookie", async () => {
    signIn(ADMIN, "robin@example.test");
    const res = await enter({ fixture: "hot-desk" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${SITE}/portal`);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${VIEW_AS_COOKIE}=fixture%3Ahot-desk%7C${ADMIN}%7C\\d+`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=3600/);
  });

  it("refuses a kind that doesn't exist or a member who doesn't", async () => {
    signIn(ADMIN, "robin@example.test");
    expect((await enter({ fixture: "nope" })).status).toBe(400);
    expect((await enter({ member_id: "999" })).status).toBe(400);
  });

  it.each([
    ["a non-admin holding a hand-made cookie", ANA, ANA],
    ["a disabled admin's old cookie", OFF, OFF],
    ["another person's cookie (the admin's) in a member's browser", ANA, ADMIN],
  ])("%s sees their own portal, not a preview", async (_label, user, cookieFor) => {
    signIn(user!, "ana@example.test");
    viewAs({ kind: "member", memberId: 4 }, cookieFor!);
    const h = await html(PortalPage());
    expect(h).not.toContain("Dee");
    if (user === ANA) expect(h).toContain("Hi, <!-- -->Ana");
  });
});

describe("each kind of member", () => {
  it.each(PORTAL_FIXTURES.map((f) => [f.key, f] as const))("%s renders, with sample data only", async (_key, f) => {
    signIn(ADMIN, "robin@example.test");
    viewAs({ kind: "fixture", key: f.key });
    const h = await html(PortalPage());
    // Nothing of the admin's own: name, email, door code, pass balance.
    expect(h).not.toContain("Robin");
    expect(h).not.toContain("robin@example.test");
    expect(h).not.toContain(ADMIN_PIN);
    expect(h).not.toContain("7 passes");
    const v = f.view(Date.now());
    if (v.member) {
      expect(h).toContain(`Hi, <!-- -->${v.member.name.split(" ")[0]}`);
      expect(h).toContain('data-testid="portal-door"');
      expect(h).toContain('data-testid="portal-more"');
    }
    if (v.subscription) expect(h).toContain('data-testid="portal-membership"');
    // A door code is only ever the placeholder (masked until revealed, or the day code shown in full).
    if (v.member?.pin_code) expect(h).toContain("Your door code");
    if (v.dayCode) expect(h).toContain(PLACEHOLDER_CODE);
    // Every control that would change something is off.
    for (const control of ["Manage subscription", "Change plan", "Yes, list me", "No thanks", "Copy Link"]) {
      const i = h.indexOf(control);
      if (i > -1) expect(h.slice(Math.max(0, h.lastIndexOf("<button", i)), i), control).toMatch(/ disabled=""/);
    }
    if (v.subscription?.payment_rail === "stripe") expect(h).toContain("Manage subscription");
  });

  it("the states say what they should", async () => {
    signIn(ADMIN, "robin@example.test");
    const page = async (key: string) => { viewAs({ kind: "fixture", key }); return html(PortalPage()); };
    expect(await page("past-due")).toContain("Your payment is past due");
    expect(await page("set-to-end")).toContain("Cancelling on");
    const firstWeek = await page("first-week");
    expect(firstWeek).toContain("Get oriented");
    expect(firstWeek).toContain('data-testid="directory-ask"');
    expect(await page("applicant")).toContain("Application <!-- -->Under Review");
    expect(await page("day-pass")).toContain("Free day reserved");
    expect(await page("day-pass-used")).toContain("Pick your plan");
    expect(await page("day-plan-30")).toContain("Member + 1 day/mo");
    expect(await page("day-plan-50")).toContain("Member + 2 days/mo");
    const steward = await page("coop-steward");
    expect(steward).toContain('href="/portal/access-log"');
    expect(steward).toContain("Invite a friend");
    expect(steward).toContain(PREVIEW_INVITE_URL);
  });

  it("the frame shows the bar and the member's menu (no Admin)", async () => {
    signIn(ADMIN, "robin@example.test");
    viewAs({ kind: "fixture", key: "day-plan-30" });
    const home = await html(PortalLayout({ children: "HOME-BODY" }));
    expect(home).toContain('data-testid="view-as-bar"');
    expect(home).toContain("$30 day plan member");
    expect(home).toContain("Day passes");
    expect(home).not.toContain('href="/admin"');
    expect(home).toContain("HOME-BODY");
  });

  it("every other portal page holds itself back before reading anything (a Stripe return on passes included)", async () => {
    signIn(ADMIN, "robin@example.test");
    viewAs({ kind: "fixture", key: "hot-desk" });
    const pages = await Promise.all([
      import("@/app/portal/passes/page"), import("@/app/portal/my-code/page"), import("@/app/portal/profile/page"),
      import("@/app/portal/access-log/page"), import("@/app/portal/events/page"), import("@/app/portal/events/old/page"),
    ]);
    // A Stripe checkout return would fulfil a purchase on this GET outside a preview.
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_preview");
    const props = { searchParams: Promise.resolve({ session_id: "cs_test_1", checkout: "success" }) };
    for (const mod of pages) {
      vi.mocked(createServiceClient).mockClear();
      vi.mocked(createClient).mockClear();
      const page = mod.default as (p: typeof props) => Promise<unknown>;
      const h = await html(page(props));
      expect(h).toContain('data-testid="not-in-preview"');
      expect(h).not.toContain(ADMIN_PIN);
      // The preview check reads only the admin's own row (the session client); no service client, no network.
      expect(createServiceClient).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("one real member", () => {
  it("shows their portal with codes masked, and records the view", async () => {
    signIn(ADMIN, "robin@example.test");
    viewAs({ kind: "member", memberId: 2 });
    const h = await html(PortalPage());
    expect(h).toContain("Hi, <!-- -->Ana");
    expect(h).not.toContain(ANA_PIN);
    expect(h).not.toContain(ADMIN_PIN);
    expect(h).toContain("Invite a friend");
    viewAs({ kind: "member", memberId: 4 });
    const dee = await html(PortalPage());
    expect(dee).toContain("Hi, <!-- -->Dee");
    expect(dee).not.toContain(ANA_DAY_CODE);
    expect(dee).toContain(PLACEHOLDER_CODE);
    const rows = await db.sql<{ action: string; actor_member_id: number; target_table: string; target_id: string }>(
      "select action, actor_member_id, target_table, target_id from admin_actions where action = 'portal_viewed_as' order by id");
    expect(rows).toEqual([
      { action: "portal_viewed_as", actor_member_id: 1, target_table: "members", target_id: "2" },
      { action: "portal_viewed_as", actor_member_id: 1, target_table: "members", target_id: "4" },
    ]);
  });
});

describe("every write is refused while a preview is on", () => {
  const APP = resolve(__dirname, "../src/app");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : n === "route.ts" ? [p] : [];
  });
  /** URL path of a route file: groups dropped, dynamic segments filled in. */
  const urlOf = (file: string) => "/" + relative(APP, file).split("/").slice(0, -1)
    .filter((s) => !/^\(.*\)$/.test(s))
    .map((s) => (s.startsWith("[...") ? "a/b" : s.startsWith("[") ? "1" : s))
    .join("/");
  const WRITES = files(APP).flatMap((file) => {
    const src = readFileSync(file, "utf8");
    return (["POST", "PUT", "PATCH", "DELETE"] as const)
      .filter((m) => new RegExp(`export (async )?function ${m}\\b|export \\{[^}]*\\bas ${m}\\b`).test(src))
      .map((m) => [m, urlOf(file)] as const);
  });
  const OPEN = new Set(["POST /api/admin/view-as", "POST /api/view-as/exit", "POST /auth/signout", "POST /techne/signin"]);
  const request = (method: string, path: string, cookie = true) => new NextRequest(`${SITE}${path}`, {
    method,
    headers: cookie ? { cookie: `${VIEW_AS_COOKIE}=${encodeURIComponent(viewAsCookieValue({ kind: "fixture", key: "hot-desk" }, ADMIN, Date.now()))}` } : {},
  });

  it("finds the write routes", () => {
    expect(WRITES.length).toBeGreaterThan(60);
    expect(WRITES.map(([m, p]) => `${m} ${p}`)).toEqual(expect.arrayContaining([
      "POST /api/portal/billing-portal", "POST /api/portal/change-plan", "DELETE /api/portal/change-plan",
      "PATCH /api/portal/profile", "POST /api/portal/buy-passes", "POST /api/portal/request-daypass",
      "POST /api/portal/regenerate-code", "POST /api/techne/rsvp", "POST /api/admin/members/1/cancel-membership",
    ]));
  });

  it.each(WRITES.filter(([m, p]) => !OPEN.has(`${m} ${p}`)).map(([m, p]) => [`${m} ${p}`, m, p] as const))(
    "%s", async (_label, method, path) => {
      const res = proxy(request(method, path));
      expect(res.status).toBe(403);
      expect((await res.json()).preview).toBe(true);
      // Without the cookie the same request goes on to its route.
      expect(proxy(request(method, path, false)).status).toBe(200);
    });

  it("a server action (a page post) and the GETs that write are refused too, however the path is spelled", () => {
    for (const [m, p] of [["POST", "/oauth/authorize"], ["POST", "/portal"], ["post", "/api/portal/profile"],
      ["GET", "/api/portal/invite"], ["HEAD", "/api/portal/invite"], ["GET", "/api/portal/%69nvite"], ["GET", "//api/portal/invite/"],
      ["GET", "/api/newsletter/unsubscribe"], ["GET", "/api/cron/billing"], ["GET", "/xrpc/x.y.z"], ["GET", "/freeday"]]) {
      expect(proxy(request(m, p)).status, `${m} ${p}`).toBe(403);
    }
  });

  it("reading pages, leaving the preview and signing out still work; an expired cookie is dropped", () => {
    for (const [m, p] of [["GET", "/portal"], ["GET", "/portal/passes"], ["GET", "/admin/view-as"],
      ["POST", "/api/admin/view-as"], ["POST", "/api/view-as/exit"], ["POST", "/auth/signout"]]) {
      expect(proxy(request(m, p)).status, `${m} ${p}`).toBe(200);
    }
    const stale = new NextRequest(`${SITE}/api/portal/profile`, {
      method: "PATCH",
      headers: { cookie: `${VIEW_AS_COOKIE}=${encodeURIComponent(viewAsCookieValue({ kind: "fixture", key: "hot-desk" }, ADMIN, Date.now() - 2 * 3600_000))}` },
    });
    const res = proxy(stale);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${VIEW_AS_COOKIE}=;`));
  });

  it("a sign-in passes and ends the preview, so whoever signs in next isn't left read-only", () => {
    for (const [m, p] of [["GET", "/auth/callback"], ["POST", "/techne/signin"], ["GET", "/techne/callback"]]) {
      const res = proxy(request(m, p));
      expect(res.status, `${m} ${p}`).toBe(200);
      expect(res.headers.get("set-cookie"), `${m} ${p}`).toMatch(new RegExp(`${VIEW_AS_COOKIE}=;`));
    }
  });

  it("someone left holding a cookie that isn't theirs sees an Exit bar on their own portal", async () => {
    signIn(ANA, "ana@example.test");
    viewAs({ kind: "fixture", key: "hot-desk" }, ADMIN);
    const h = await html(PortalLayout({ children: "ANA-HOME" }));
    expect(h).toContain('data-testid="view-as-bar"');
    expect(h).toContain("still on in this browser");
    expect(h).toContain('action="/api/view-as/exit"');
    expect(h).toContain("ANA-HOME");
  });

  it("the rule is default-deny", () => {
    expect(viewAsRefuses("POST", "/api/some/route/added/later")).toBe(true);
    expect(viewAsRefuses("PUT", "/anything")).toBe(true);
    expect(viewAsRefuses("GET", "/api/some/route/added/later")).toBe(false);
  });
});
