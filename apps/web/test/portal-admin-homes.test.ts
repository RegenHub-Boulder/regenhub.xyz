/**
 * The two rebuilt home pages (T-482 audit): /portal (members) and /admin ("Today", admins), rendered from the real
 * pages against a real Postgres (PGlite, every migration applied). They check that every control the old pages had is
 * still reachable after the move, and that the order follows what people come for. Faked: only the signed-in session
 * and the network edge (Techne is unconfigured, so the scoreboard's event turnout is empty).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToReadableStream } from "react-dom/server";
import { makePgDb, type PgDb } from "./pgDb";
import { startOfDayIn } from "@/lib/series";
import { SCOREBOARD_TZ } from "@/lib/scoreboard";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
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
import AdminHome from "@/app/admin/(staff)/page";
import ScoreboardPage from "@/app/admin/(staff)/scoreboard/page";
import MembersPage from "@/app/admin/(staff)/members/page";

const ADMIN = "00000000-0000-4000-8000-00000000000a";
const ANA = "00000000-0000-4000-8000-0000000000a2";
const SAM = "00000000-0000-4000-8000-0000000000b5";
const WRITER = "00000000-0000-4000-8000-000000000482";
/** A moment earlier today in Boulder: `minutes` ago, but never before midnight (so the test can run at 00:01). */
const inToday = (minutes: number) => new Date(Math.max(Date.now() - minutes * 60_000,
  startOfDayIn(SCOREBOARD_TZ).getTime() + minutes * 1000)).toISOString();
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

let db: PgDb;

async function world() {
  db = await makePgDb();
  // Door codes go in under a PIN-writer reservation, as the app writes them (migration 053's guard).
  await db.exec(`select acquire_lock_writer('${WRITER}');
    select set_config('request.headers', '{"x-lock-writer-token":"${WRITER}"}', false);
    insert into auth.users (id, email) values ('${ADMIN}', 'robin@example.test'), ('${ANA}', 'ana@example.test'), ('${SAM}', 'sam@example.test');
    insert into members (id, name, email, member_type, is_admin, is_coop_member, supabase_user_id, pin_code, pin_code_slot, day_passes_balance, created_at) values
      (1, 'Robin Sample', 'robin@example.test', 'cold_desk', true, true, '${ADMIN}', '204611', 1, 0, '${ago(700)}'),
      (2, 'Ana Sample', 'ana@example.test', 'hot_desk', false, true, '${ANA}', '583027', 2, 3, '${ago(300)}'),
      (3, 'Theo Sample', 'theo@example.test', 'hot_desk', false, false, null, '551920', 3, 0, '${ago(200)}'),
      (4, 'Uma Sample', 'uma@example.test', 'cold_desk', false, false, null, null, null, 0, '${ago(30)}'),
      (5, 'Sam Sample', 'sam@example.test', 'day_pass', false, false, '${SAM}', null, null, 0, '${ago(0.2)}');
    insert into subscriptions (member_id, plan_key, monthly_cents, net_cents, status, current_period_end, past_due_since,
        stripe_subscription_id, stripe_customer_id, stripe_price_id, created_at) values
      (1, 'cold_desk', 50000, 50000, 'active', '${ahead(18)}', null, 'sub_1', 'cus_1', 'price_x', '${ago(600)}'),
      (2, 'hot_desk', 25000, 25000, 'active', '${ahead(18)}', null, 'sub_2', 'cus_2', 'price_x', '${ago(290)}'),
      (3, 'hot_desk', 25000, 25000, 'past_due', '${ago(6)}', '${ago(6)}', 'sub_3', 'cus_3', 'price_x', '${ago(190)}');
    insert into applications (email, name, membership_interest, status) values ('olu@example.test', 'Olu Sample', 'hot_desk', 'pending');
    insert into free_day_claims (email, name, status, supabase_user_id, claimed_date) values ('sam@example.test', 'Sam Sample', 'reserved', '${SAM}', current_date);
    insert into lock_sync_runs (synced, failed, partial, results) values (9, 1, 0, '[]');
    insert into access_logs (member_id, method, result, created_at) values (2, 'pin', 'granted', '${inToday(1)}'), (1, 'pin', 'granted', '${inToday(2)}'),
      (3, 'pin', 'granted', now() - interval '30 hours');
    select set_config('request.headers', '{}', false); select release_lock_writer('${WRITER}');`);
  vi.mocked(createServiceClient).mockReturnValue(db as never);
}

function signIn(userId: string, email: string) {
  vi.mocked(createClient).mockResolvedValue({
    from: db.from,
    auth: { getUser: async () => ({ data: { user: { id: userId, email } } }) },
  } as never);
}

/** Server-rendered HTML; streamed, since the pages hold async server components (the day-pass hero). */
const html = async (page: () => Promise<unknown>) => {
  const stream = await renderToReadableStream((await page()) as never);
  await stream.allReady;
  return new Response(stream).text();
};
/** Where each piece starts in the page, to check the order. */
const at = (h: string, needle: string) => {
  const i = h.indexOf(needle);
  expect(i, `${needle} on the page`).toBeGreaterThan(-1);
  return i;
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("REGENOS_BASE_URL", "");
  vi.stubEnv("TECHNE_SIGNIN_ENABLED", "");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  await world();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.close();
});

describe("member home (/portal)", () => {
  it("leads with the door: the code, then a guest code, then the plan, then the rest", async () => {
    signIn(ANA, "ana@example.test");
    const h = await html(PortalPage);
    // The door code is on the home now (masked until revealed), with the old door-code page one click away.
    const door = at(h, 'data-testid="portal-door"');
    expect(h).toContain("Your door code");
    expect(h).toContain("••••••");
    expect(h).not.toContain("583027");
    expect(h).toContain('href="/portal/my-code"');
    // The old Day Passes card is the guest-code link, with the balance.
    expect(h).toMatch(/href="\/portal\/passes">Guest code<!-- --> \(3 passes left\)/);
    // The old Hub activity card is one line, counted since midnight (Theo came in yesterday); co-op members can open
    // who came in.
    expect(h).toMatch(/data-testid="here-today" href="\/portal\/access-log">2 members in today/);
    // The plan, with its controls (card member: change plan and manage subscription).
    const plan = at(h, 'data-testid="portal-membership"');
    expect(h).toContain("Change plan");
    expect(h).toContain("Manage subscription");
    // Everything else: profile, invite, hub essentials.
    const more = at(h, 'data-testid="portal-more"');
    expect(h).toContain('href="/portal/profile"');
    expect(h).toContain("Invite a friend");
    expect(door).toBeLessThan(plan);
    expect(plan).toBeLessThan(more);
    // Gone from the home: the stats card and the stewards' card (Events stays in the menu).
    expect(h).not.toContain("Hub activity");
    expect(h).not.toContain("Manage Events");
  });

  it("a day-pass newcomer gets their free day and day passes first, and the first-week steps", async () => {
    signIn(SAM, "sam@example.test");
    const h = await html(PortalPage);
    const door = at(h, 'data-testid="portal-door"');
    expect(h).toContain("Free day reserved");
    expect(h).toContain("Tap to get your door code");
    expect(h).toContain('href="/freeday"');
    expect(h).toMatch(/href="\/portal\/passes"/);
    expect(at(h, "Get oriented")).toBeGreaterThan(door);
    // Not a co-op member: the count, without the log.
    expect(h).not.toContain('href="/portal/access-log"');
  });
});

describe("admin home (/admin, Today)", () => {
  it("shows what's waiting, then what to do next, with the goals in one line and the shortcuts kept", async () => {
    signIn(ADMIN, "robin@example.test");
    const h = await html(AdminHome);
    expect(h).toContain(">Today</h1>");
    expect(h).toMatch(/2<!-- --> of <!-- -->22<\/span> paying members/);
    expect(h).toContain('href="/admin/scoreboard"');
    // Waiting on you: the lock and Theo's missed payment first (urgent), then the application, then the unbilled desk.
    const waiting = at(h, 'data-testid="admin-waiting"');
    const lock = at(h, "The last lock sync failed on 1 code");
    const pastDue = at(h, "1 subscription past due");
    const app = at(h, "1 application to review");
    expect(lock).toBeLessThan(pastDue);
    expect(pastDue).toBeLessThan(app);
    const desk = at(h, "1 desk member not billed");
    expect(app).toBeLessThan(desk);
    expect(h).toContain('href="/admin/access?tab=sync"');
    expect(h).toContain('href="/admin/people?tab=applications"');
    expect(h).toContain('href="/admin/members?status=unbilled_desk"');
    // What to do next moved here from the scoreboard: Theo is past due, with the one-click reminder.
    const next = at(h, 'data-testid="admin-next"');
    expect(waiting).toBeLessThan(next);
    expect(at(h, "Theo Sample")).toBeGreaterThan(next);
    expect(h).toContain("Send reminder");
    // The old quick actions are still one click away (Stale auth links moved to Members).
    expect(h).toContain('href="/admin/access?tab=codes"');
    expect(h).toContain('href="/admin/members/new"');
    expect(h).toContain('href="/admin/members"');
    // Gone: the stat cards, the all-time funnel and the three recent lists.
    for (const old of ["Live Door Codes", "Funnel", "Recent Members", "Recent Codes"]) expect(h).not.toContain(old);
  });

  it("says when nothing is waiting", async () => {
    await db.exec(`update applications set status = 'approved'; delete from lock_sync_runs; update subscriptions set status = 'active', past_due_since = null where member_id = 3;
      insert into subscriptions (member_id, plan_key, monthly_cents, net_cents, status, stripe_subscription_id, stripe_customer_id, stripe_price_id)
      values (4, 'cold_desk', 50000, 50000, 'active', 'sub_4', 'cus_4', 'price_x');`);
    signIn(ADMIN, "robin@example.test");
    expect(await html(AdminHome)).toContain("Nothing waiting.");
  });

  it("if the scoreboard can't be read, what's waiting still shows; a failed queue read says so", async () => {
    // Both reads fail for real: the scoreboard's purchases and the quarantine table are gone.
    await db.exec("drop table purchases cascade; drop table lock_slot_quarantine cascade;");
    signIn(ADMIN, "robin@example.test");
    const h = await html(AdminHome);
    expect(h).toContain("1 application to review");
    expect(h).toContain("Couldn&#x27;t check quarantined door slots");
    expect(h).toContain("read the scoreboard just now");
    expect(h).not.toContain("Nothing waiting.");
  });

  it("sends a member who isn't an admin to their portal", async () => {
    signIn(ANA, "ana@example.test");
    await expect(AdminHome()).rejects.toMatchObject({ digest: expect.stringContaining("/portal") });
  });

  it("the scoreboard keeps the numbers and points to Today for the actions", async () => {
    signIn(ADMIN, "robin@example.test");
    const h = await html(ScoreboardPage);
    expect(h).toMatch(/What to do next \(<!-- -->\d+<!-- --> open\) is on <a [^>]*href="\/admin">Today/);
    expect(h).not.toContain("Send reminder");
    expect(h).toContain('data-testid="paying-members"');
  });

  it("Stale auth links, once a quick action on the old home, is on the members page", async () => {
    signIn(ADMIN, "robin@example.test");
    const h = await html(() => MembersPage());
    expect(h).toMatch(/href="\/admin\/members\/stale-links"[^>]*>Stale auth links/);
  });
});
