/**
 * Round 2 of the T-482 portal/admin audit: every route in the audit's table still reachable, old URLs landing on their
 * new homes, the two navs at their new length and names, and the merged pages (People, Mail, Billing) holding what
 * they took in. Pages render from the real code against a real Postgres (PGlite, every migration applied); faked:
 * only the signed-in session, the request headers and the network edge (Techne is unconfigured).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToReadableStream } from "react-dom/server";
import { makePgDb, type PgDb } from "./pgDb";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
const path = vi.hoisted(() => ({ current: "/portal" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-pathname": path.current }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set() {}, delete() {} }),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  usePathname: () => path.current,
  useRouter: () => ({ refresh() {}, replace() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import AdminLayout from "@/app/admin/layout";
import PortalLayout from "@/app/portal/layout";
import PeoplePage from "@/app/admin/people/page";
import MembersPage from "@/app/admin/(staff)/members/page";
import MailPage from "@/app/admin/(staff)/mail/page";
import BillingPage from "@/app/admin/(staff)/billing/page";

const ADMIN = "00000000-0000-4000-8000-00000000000a";
const ANA = "00000000-0000-4000-8000-0000000000a2";
const SAM = "00000000-0000-4000-8000-0000000000b5";
const WRITER = "00000000-0000-4000-8000-000000000482";
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

let db: PgDb;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REGENOS_BASE_URL", "");
  vi.stubEnv("TECHNE_SIGNIN_ENABLED", "");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The sample world, for the tests that render pages (the route checks need none). */
async function world() {
  db = await makePgDb();
  await db.exec(`select acquire_lock_writer('${WRITER}');
    select set_config('request.headers', '{"x-lock-writer-token":"${WRITER}"}', false);
    insert into auth.users (id, email) values ('${ADMIN}', 'robin@example.test'), ('${ANA}', 'ana@example.test'), ('${SAM}', 'sam@example.test');
    insert into members (id, name, email, member_type, is_admin, supabase_user_id, pin_code, pin_code_slot, created_at) values
      (1, 'Robin Sample', 'robin@example.test', 'cold_desk', true, '${ADMIN}', '204611', 1, '${ago(700)}'),
      (2, 'Ana Sample', 'ana@example.test', 'hot_desk', false, '${ANA}', '583027', 2, '${ago(300)}'),
      (3, 'Theo Sample', 'theo@example.test', 'hot_desk', false, null, '551920', 3, '${ago(200)}'),
      (5, 'Sam Sample', 'sam@example.test', 'day_pass', false, '${SAM}', null, null, '${ago(0.2)}');
    insert into subscriptions (member_id, plan_key, monthly_cents, net_cents, status, current_period_end, past_due_since,
        stripe_subscription_id, stripe_customer_id, stripe_price_id, created_at) values
      (1, 'cold_desk', 50000, 50000, 'active', '${ahead(18)}', null, 'sub_1', 'cus_1', 'price_x', '${ago(600)}'),
      (3, 'hot_desk', 25000, 25000, 'past_due', '${ago(6)}', '${ago(6)}', 'sub_3', 'cus_3', 'price_x', '${ago(190)}');
    insert into applications (email, name, membership_interest, status) values
      ('olu@example.test', 'Olu Sample', 'hot_desk', 'pending'), ('kai@example.test', 'Kai Sample', 'day_pass', 'pending');
    insert into free_day_claims (email, name, status, claimed_date) values ('ivy@example.test', 'Ivy Sample', 'pending', current_date + 3);
    insert into interests (email, name) values ('lee@example.test', 'Lee Sample');
    select set_config('request.headers', '{}', false); select release_lock_writer('${WRITER}');`);
  vi.mocked(createServiceClient).mockReturnValue(db as never);
}
const withWorld = () => {
  beforeEach(world);
  afterEach(async () => { await db.close(); });
};

function signIn(userId: string, email: string) {
  vi.mocked(createClient).mockResolvedValue({
    from: db.from,
    auth: { getUser: async () => ({ data: { user: { id: userId, email } } }) },
  } as never);
}

const html = async (node: unknown) => {
  const stream = await renderToReadableStream((await node) as never);
  await stream.allReady;
  return new Response(stream).text();
};
/** The visible labels of the desktop nav bar's links, in order. */
const navLabels = (h: string) => {
  const bar = h.slice(h.indexOf('class="hidden sm:flex gap-4 text-sm"'));
  const end = bar.indexOf("</div>");
  return [...bar.slice(0, end).matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
};

/** Where a redirect page sends you (Next throws NEXT_REDIRECT with the URL in its digest). */
async function redirectOf(load: () => Promise<{ default: (a: never) => unknown }>, searchParams: Record<string, string> = {}) {
  const page = (await load()).default;
  try {
    await page({ searchParams: Promise.resolve(searchParams) } as never);
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
    throw e;
  }
  throw new Error("no redirect");
}

describe("every route in the audit's table", () => {
  // The audit's route table (AUDIT-PORTAL-ADMIN.md) plus round 2's new homes. Each one still has a page.
  const ROUTES = [
    "/portal", "/portal/my-code", "/portal/passes", "/portal/profile", "/portal/access-log", "/portal/events",
    "/portal/events/old",
    "/admin", "/admin/scoreboard", "/admin/people", "/admin/pipeline", "/admin/applications", "/admin/interests",
    "/admin/claims", "/admin/members", "/admin/members/[id]", "/admin/members/new", "/admin/members/stale-links",
    "/admin/billing", "/admin/access", "/admin/codes", "/admin/lock", "/admin/communications", "/admin/newsletter",
    "/admin/mail", "/admin/events", "/admin/stewards", "/admin/view-as",
  ];
  const app = resolve(__dirname, "../src/app");
  it.each(ROUTES)("%s has a page", (route) => {
    const parts = route.split("/").filter(Boolean);
    const plain = resolve(app, ...parts, "page.tsx");
    const staff = parts[0] === "admin" ? resolve(app, "admin", "(staff)", ...parts.slice(1), "page.tsx") : plain;
    expect(existsSync(plain) || existsSync(staff), route).toBe(true);
  });

  it("old URLs land on their new homes", async () => {
    expect(await redirectOf(() => import("@/app/admin/(staff)/pipeline/page"))).toBe("/admin/people");
    expect(await redirectOf(() => import("@/app/admin/(staff)/pipeline/page"), { tab: "freedays" })).toBe("/admin/people?tab=freedays");
    expect(await redirectOf(() => import("@/app/admin/(staff)/applications/page"))).toBe("/admin/people?tab=applications");
    expect(await redirectOf(() => import("@/app/admin/(staff)/claims/page"))).toBe("/admin/people?tab=freedays");
    expect(await redirectOf(() => import("@/app/admin/(staff)/interests/page"), { linked: "false" })).toBe("/admin/people?tab=interests&linked=false");
    expect(await redirectOf(() => import("@/app/admin/(staff)/newsletter/page"))).toBe("/admin/mail");
    expect(await redirectOf(() => import("@/app/admin/(staff)/communications/page"))).toBe("/admin/mail?tab=group");
    expect(await redirectOf(() => import("@/app/admin/stewards/page"))).toBe("/admin/events?roles=open#roles");
    expect(await redirectOf(() => import("@/app/admin/(staff)/codes/page"))).toMatch(/^\/admin\/access/);
    expect(await redirectOf(() => import("@/app/admin/(staff)/lock/page"))).toMatch(/^\/admin\/access/);
  });
});

describe("the navs", () => {
  withWorld();
  it("admin: Today · Scoreboard · People · Billing · Door · Mail (Events joins sixth with the Techne door on)", async () => {
    signIn(ADMIN, "robin@example.test");
    path.current = "/admin";
    expect(navLabels(await html(AdminLayout({ children: null })))).toEqual(["Today", "Scoreboard", "People", "Billing", "Door", "Mail"]);
  });

  it("a member who isn't an admin sees no staff links", async () => {
    signIn(ANA, "ana@example.test");
    expect(navLabels(await html(AdminLayout({ children: null })))).toEqual([]);
  });

  it("member: Home · Guest passes; a daily member's passes are their Day passes; an admin also gets Admin", async () => {
    path.current = "/portal";
    signIn(ANA, "ana@example.test");
    expect(navLabels(await html(PortalLayout({ children: null })))).toEqual(["Home", "Guest passes"]);
    signIn(SAM, "sam@example.test");
    expect(navLabels(await html(PortalLayout({ children: null })))).toEqual(["Home", "Day passes"]);
    signIn(ADMIN, "robin@example.test");
    expect(navLabels(await html(PortalLayout({ children: null })))).toEqual(["Home", "Guest passes", "Admin"]);
  });
});

describe("the merged pages", () => {
  withWorld();
  beforeEach(() => signIn(ADMIN, "robin@example.test"));

  it("People opens on Applications, tabs in order with pending counts, and each tab reads its own rows", async () => {
    const h = await html(PeoplePage({ searchParams: Promise.resolve({}) }));
    const tabs = [...h.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(Applications|Free days|Interests|Members)/g)].map((m) => [m[2], m[1]]);
    expect(tabs).toEqual([
      ["Applications", "/admin/people?tab=applications"],
      ["Free days", "/admin/people?tab=freedays"],
      ["Interests", "/admin/people?tab=interests"],
      ["Members", "/admin/members"],
    ]);
    expect(h).toMatch(/aria-current="page"[^>]*>Applications/);
    expect(h).toMatch(/>Applications<span[^>]*>2<\/span>/);
    expect(h).toMatch(/>Free days<span[^>]*>1<\/span>/);
    expect(h).toContain("Olu Sample");
    expect(h).not.toContain("Ivy Sample");

    const free = await html(PeoplePage({ searchParams: Promise.resolve({ tab: "freedays" }) }));
    expect(free).toContain("Ivy Sample");
    expect(free).not.toContain("Olu Sample");
    const interests = await html(PeoplePage({ searchParams: Promise.resolve({ tab: "interests" }) }));
    expect(interests).toContain("lee@example.test");
  });

  it("Members is People's fourth tab; the rare tools sit under More", async () => {
    const h = await html(MembersPage());
    expect(h).toMatch(/aria-current="page"[^>]*>Members/);
    const more = h.slice(h.indexOf('data-testid="members-more"'));
    expect(more).toContain('href="/admin/members/stale-links"');
    expect(more).toContain("Sync claims to regenOS");
    expect(h).toContain(">Add member<");
  });

  it("Mail holds the newsletter studio and Send to a group; the old note and auto-send are gone", async () => {
    const h = await html(MailPage());
    expect(h).toContain(">Mail</h1>");
    expect(h).toContain(">Newsletter</button>");
    expect(h).toContain(">Send to a group</button>");
    expect(h).not.toMatch(/Newsletter note|Biweekly newsletter|NEWSLETTER_AUTOSEND_ENABLED/);
  });

  it("Billing points to the Scoreboard and Today instead of repeating their totals and past-due list", async () => {
    const h = await html(BillingPage());
    const pointers = h.slice(h.indexOf('data-testid="billing-pointers"'));
    expect(pointers).toContain('href="/admin/scoreboard"');
    expect(pointers).toContain('href="/admin"');
    expect(pointers).toMatch(/1(<!-- -->)? past due/);
    expect(pointers).toContain('href="/admin/members?status=overdue"');
    expect(h).not.toContain("Past due — needs attention");
    expect(h).not.toContain(">MRR<");
    expect(h).not.toContain("Queued to cancel");
    // The lists stay: every subscription, with Theo's among them.
    expect(h).toContain("All subscriptions");
    expect(h).toContain("Theo Sample");
  });
});
