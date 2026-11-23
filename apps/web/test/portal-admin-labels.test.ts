/**
 * Follow-ups from the T-482 portal/admin audit, rendered from the real pages against a real Postgres (PGlite, every
 * migration applied): the member page's Billing tab (one box per subscription, Send reminder when past due), the
 * Access page's labels, the Scoreboard's "How we count" toggle, and Hub Essentials opening only on a newcomer's visit
 * day. Faked: only the signed-in session, the URL's ?tab= and the network edge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToReadableStream } from "react-dom/server";
import { makePgDb, type PgDb } from "./pgDb";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const url = vi.hoisted(() => ({ tab: "" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// No portal preview cookie (lib/viewAs.ts): the member's own home.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {}, replace() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(url.tab ? { tab: url.tab } : {}),
}));

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import PortalPage from "@/app/portal/page";
import MemberPage from "@/app/admin/(staff)/members/[id]/page";
import AccessPage from "@/app/admin/(staff)/access/page";
import ScoreboardPage from "@/app/admin/(staff)/scoreboard/page";

const ADMIN = "00000000-0000-4000-8000-00000000000a";
const SAM = "00000000-0000-4000-8000-0000000000b5";
const WRITER = "00000000-0000-4000-8000-000000000483";
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
/** A calendar day in Boulder, `offset` days from today, as YYYY-MM-DD. */
const boulderDay = (offset = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date(Date.now() + offset * 86_400_000));

let db: PgDb;

/** Runs SQL under a PIN-writer reservation, as the app writes door codes (migration 053's guard). */
const asWriter = (sql: string) => db.exec(`select acquire_lock_writer('${WRITER}');
  select set_config('request.headers', '{"x-lock-writer-token":"${WRITER}"}', false);
  ${sql}
  select set_config('request.headers', '{}', false); select release_lock_writer('${WRITER}');`);

beforeEach(async () => {
  vi.clearAllMocks();
  url.tab = "";
  vi.stubEnv("REGENOS_BASE_URL", "");
  vi.stubEnv("TECHNE_SIGNIN_ENABLED", "");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  db = await makePgDb();
  await asWriter(`
    insert into auth.users (id, email) values ('${ADMIN}', 'robin@example.test'), ('${SAM}', 'sam@example.test');
    insert into members (id, name, email, member_type, is_admin, is_coop_member, supabase_user_id, pin_code, pin_code_slot, day_passes_balance, created_at) values
      (1, 'Robin Sample', 'robin@example.test', 'cold_desk', true, true, '${ADMIN}', '204611', 1, 0, '${ago(700)}'),
      (3, 'Theo Sample', 'theo@example.test', 'hot_desk', false, false, null, '551920', 3, 0, '${ago(200)}'),
      (5, 'Sam Sample', 'sam@example.test', 'day_pass', false, false, '${SAM}', null, null, 1, '${ago(0.2)}');
    insert into subscriptions (member_id, plan_key, monthly_cents, net_cents, status, current_period_end, past_due_since,
        stripe_subscription_id, stripe_customer_id, stripe_price_id, created_at) values
      (1, 'cold_desk', 50000, 50000, 'active', '${ahead(18)}', null, 'sub_1', 'cus_1', 'price_x', '${ago(600)}'),
      (3, 'hot_desk', 25000, 25000, 'past_due', '${ago(6)}', '${ago(6)}', 'sub_3', 'cus_3', 'price_x', '${ago(190)}');
    insert into lock_slot_quarantine (slot, reason, quarantined_at) values (7, 'clear failed on back door', '2026-11-20T22:04:00Z');`);
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  signIn(ADMIN, "robin@example.test");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.close();
});

function signIn(userId: string, email: string) {
  vi.mocked(createClient).mockResolvedValue({
    from: db.from,
    auth: { getUser: async () => ({ data: { user: { id: userId, email } } }) },
  } as never);
}

const html = async (page: () => Promise<unknown>) => {
  const stream = await renderToReadableStream((await page()) as never);
  await stream.allReady;
  return new Response(stream).text();
};
const count = (h: string, needle: string) => h.split(needle).length - 1;
const memberPage = (id: number) => () => MemberPage({ params: Promise.resolve({ id: String(id) }) });

describe("member page, Billing tab", () => {
  it("a past-due member has one subscription box, one status, and the reminder beside every old control", async () => {
    url.tab = "billing";
    const h = await html(memberPage(3));
    expect(count(h, 'data-testid="subscription-box"')).toBe(1);
    expect(count(h, 'data-testid="subscription-status"')).toBe(1);
    expect(h).toMatch(/data-testid="subscription-status">Past due</);
    // The old "Membership" box is gone; its controls live in the one box.
    expect(h).not.toContain(">Billing</h3>");
    for (const control of ["Send reminder", "Apply credit", "Revoke access", "Cancel membership", "Card · Stripe"]) {
      expect(h, control).toContain(control);
    }
  });

  it("a member who pays on time gets no reminder button", async () => {
    url.tab = "billing";
    const h = await html(memberPage(1));
    expect(h).toMatch(/data-testid="subscription-status">Active</);
    expect(h).toContain("Cancel membership");
    expect(h).not.toContain("Send reminder");
  });
});

describe("access page labels", () => {
  it("says which codes it counts, shows quarantine times in Boulder time and member types in words", async () => {
    url.tab = "sync";
    const h = await html(AccessPage);
    expect(h).toMatch(/0<!-- --> guest <!-- -->codes<!-- --> live/);
    expect(h).toContain("Member codes");
    expect(h).not.toContain("Active codes");
    // 22:04 UTC is 3:04 PM in Boulder (MST).
    expect(h).toMatch(/since <!-- -->Nov 20, 3:04\sPM/);
    expect(h).not.toContain("2026-11-20T22:04");
    expect(h).toContain(">Cold Desk</div>");
    expect(h).toContain(">Hot Desk</div>");
    expect(h).not.toMatch(/cold_desk|hot_desk/);
  });
});

describe("scoreboard", () => {
  it("keeps the definitions behind a closed How we count toggle", async () => {
    const h = await html(ScoreboardPage);
    const details = h.match(/<details[^>]*data-testid="how-we-count"[^>]*>/)?.[0];
    expect(details).toBeDefined();
    expect(details).not.toMatch(/\sopen/);
    expect(h).toMatch(/<summary[^>]*>How we count<\/summary><p[^>]*>\s*Paying = an active/);
  });
});

describe("Hub Essentials on the member home", () => {
  // The WiFi section only renders when the panel is open.
  const open = (h: string) => h.includes(">WiFi</h4>");

  // Free days have no date (any weekday), so the claim alone never opens it; the code they get on the day does.
  it("is open on a newcomer's free day, once its door code is live", async () => {
    await db.exec(`insert into free_day_claims (email, name, status, supabase_user_id, claimed_date)
      values ('sam@example.test', 'Sam Sample', 'reserved', '${SAM}', null);`);
    await asWriter(`insert into day_codes (member_id, label, code, pin_slot, expires_at)
      values (5, 'Free Day: Sam Sample', '482914', 131, '${ahead(0.3)}');`);
    signIn(SAM, "sam@example.test");
    expect(open(await html(PortalPage))).toBe(true);
  });

  it("is closed while the free day is only claimed (no code yet), even with an old requested date of today", async () => {
    await db.exec(`insert into free_day_claims (email, name, status, supabase_user_id, claimed_date)
      values ('sam@example.test', 'Sam Sample', 'reserved', '${SAM}', '${boulderDay()}');`);
    signIn(SAM, "sam@example.test");
    const h = await html(PortalPage);
    expect(h).toContain("Hub Essentials");
    expect(open(h)).toBe(false);
  });

  it("is open while a newcomer's day-pass code is live", async () => {
    await asWriter(`insert into day_codes (member_id, label, code, pin_slot, expires_at)
      values (5, 'Day pass', '482913', 130, '${ahead(0.3)}');`);
    signIn(SAM, "sam@example.test");
    expect(open(await html(PortalPage))).toBe(true);
  });

  it("stays closed for an established member", async () => {
    signIn(ADMIN, "robin@example.test");
    const h = await html(PortalPage);
    expect(h).toContain("Hub Essentials");
    expect(open(h)).toBe(false);
  });
});
