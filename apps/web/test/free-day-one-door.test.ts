/**
 * A free day is one day, reached by one door (T-482 round 4). Real routes on a real schema (PGlite with every
 * migration, so the approval trigger that grants the free-day pass runs), the staging outbox as the mail provider.
 * Faked: the door locks (Home Assistant) and the clock's weekday.
 *
 *   - approve → /freeday → /portal/passes refuses with a plain line, and the reverse;
 *   - a member's claim is answered "already a member" and writes no row;
 *   - an approved claim unused for FREE_DAY_LAPSE_DAYS lapses, its pass goes back, and asking again reopens the row;
 *   - a claim needing review gets a "got it" email, a declined one a kind email, each in email_log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "./pgDb";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => ({ id: "00000000-0000-0000-0000-00000000a0a0" })) }));
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  // The door locks are the one outside system here.
  setUserCode: vi.fn(async () => [{ entity: "lock.front_door_lock", ok: true }]),
}));

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { POST as claimRoute } from "@/app/api/freeday/route";
import { POST as activateRoute } from "@/app/api/freeday/activate/route";
import { POST as passRoute } from "@/app/api/portal/request-daypass/route";
import { PATCH as adminClaims } from "@/app/api/admin/claims/route";
import { lapseFreeDays, FREE_DAY_LAPSE_DAYS, ALREADY_MEMBER } from "@/lib/freeDayClaim";
import { stagingOutboxMails } from "@/lib/staging/outbox";

const DAY = 86_400_000;
let db: PgDb;
let signedIn: { id: string; email: string } | null = null;

/** The next weekday at 11am Denver, after now: activation refuses weekends, and DB-stamped rows stay before it. */
function nextWeekdayNoon() {
  const d = new Date(Date.now() + DAY);
  d.setUTCHours(18, 0, 0, 0);
  while ([0, 6].includes(d.getUTCDay())) d.setTime(d.getTime() + DAY);
  return d;
}

beforeEach(async () => {
  db = await makePgDb();
  signedIn = null;
  // Supabase Auth (the sign-in link email) is GoTrue, outside the database: a stand-in that says it sent.
  vi.mocked(createServiceClient).mockReturnValue({ ...db, auth: { signInWithOtp: async () => ({ error: null }) } } as never);
  vi.mocked(createClient).mockImplementation(async () => ({
    auth: { getUser: async () => ({ data: { user: signedIn }, error: null }) },
    from: db.from,
  }) as never);
  (globalThis as { __regenhubStagingOutbox?: unknown[] }).__regenhubStagingOutbox = [];
  vi.stubEnv("EMAIL_PROVIDER", "outbox");
  vi.stubEnv("EMAIL_FROM", "RegenHub <hello@regenhub.test>");
  vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:18700");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nextWeekdayNoon());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const json = (body: unknown) => new Request("http://127.0.0.1:18700/api", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

async function ask(email: string, name = "Fran Free") {
  return claimRoute(json({ name, email, about: "Building a garden map.", why_join: "To meet people." }));
}
async function approve(email: string) {
  const [{ id }] = await db.sql<{ id: number }>("select id from free_day_claims where email = $1", [email]);
  const res = await adminClaims(new Request("http://x/api/admin/claims", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status: "reserved" }),
  }));
  expect(res.status).toBe(200);
  return id;
}
/** Sign in as this email: the auth user, linked to the claim and the member row by the 004/014 triggers. */
async function signIn(email: string) {
  const id = `00000000-0000-0000-0000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
  await db.sql("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, email]);
  signedIn = { id, email };
}
const claimOf = async (email: string) =>
  (await db.sql<{ id: number; status: string; day_code_id: number | null; created_at: string }>(
    "select id, status, day_code_id, created_at from free_day_claims where email = $1", [email]))[0];
const memberOf = async (email: string) =>
  (await db.sql<{ id: number; day_passes_balance: number }>("select id, day_passes_balance from members where email = $1", [email]))[0];
const codesOf = async (memberId: number) =>
  db.sql<{ id: number; code: string }>("select id, code from day_codes where member_id = $1 order by id", [memberId]);
/** A door code written by hand, as an older door wrote it: inside a PIN-writer reservation, as the schema requires. */
async function seedCode(memberId: number, code: string, slot: number, issuedAt: string, expiresAt: string, revoked = false) {
  await db.exec(`select acquire_lock_writer('0000000a-0000-4000-8000-00000000beef');
    select set_config('request.headers', '{"x-lock-writer-token":"0000000a-0000-4000-8000-00000000beef"}', false);
    insert into day_codes (member_id, code, pin_slot, expires_at, issued_at, is_active, revoked_at)
      values (${memberId}, '${code}', ${slot}, '${expiresAt}', '${issuedAt}', ${!revoked}, ${revoked ? `'${issuedAt}'` : "null"});
    select set_config('request.headers', '{}', false);
    select release_lock_writer('0000000a-0000-4000-8000-00000000beef');`);
}
const mailTo = (email: string) => stagingOutboxMails().filter((m) => m.to === email);

describe("one door to a free day", () => {
  it("/freeday first: the pass is spent, and Day passes says the free day is used", async () => {
    expect((await ask("fran@example.test")).status).toBe(200);
    await approve("fran@example.test");
    expect((await memberOf("fran@example.test")).day_passes_balance).toBe(1);
    const approval = mailTo("fran@example.test").find((m) => m.subject === "Your free day at RegenHub is ready")!;
    expect(approval.html).toContain("http://127.0.0.1:18700/freeday");
    expect(approval.html).not.toContain("/portal/passes");

    await signIn("fran@example.test");
    const res = await activateRoute();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.code).toMatch(/^\d{5,6}$/);
    const member = await memberOf("fran@example.test");
    expect(member.day_passes_balance).toBe(0);
    expect((await claimOf("fran@example.test")).status).toBe("activated");

    const second = await passRoute(json({}));
    expect(second.status).toBe(400);
    expect((await second.json()).error).toMatch(/^You've had your free day \(\w{3} \d+\)\. Buy a day pass below to come again\.$/);
    expect(await codesOf(member.id)).toHaveLength(1);

    // A reload the same day gets the same code back, never a new one; once it has run out, a plain no.
    const again = await (await activateRoute()).json();
    expect(again).toMatchObject({ code: body.code, already_activated: true });
    await db.sql("update day_codes set expires_at = now() - interval '1 day' where member_id = $1", [member.id]);
    const later = await activateRoute();
    expect(later.status).toBe(409);
    expect((await later.json()).error).toMatch(/^You've had your free day \(\w{3} \d+\)\. To come again, a day pass is \$30 on Day passes\.$/);
    expect(await codesOf(member.id)).toHaveLength(1);
  });

  it("Day passes first: the claim is marked used, and /freeday issues no second code", async () => {
    await ask("gus@example.test", "Gus Guest");
    await approve("gus@example.test");
    await signIn("gus@example.test");

    const res = await passRoute(json({}));
    expect(res.status).toBe(200);
    const member = await memberOf("gus@example.test");
    const [code] = await codesOf(member.id);
    expect(await claimOf("gus@example.test")).toMatchObject({ status: "activated", day_code_id: code.id });

    expect(await (await activateRoute()).json()).toMatchObject({ code: code.code, already_activated: true });
    await db.sql("update day_codes set expires_at = now() - interval '1 day' where member_id = $1", [member.id]);
    const later = await activateRoute();
    expect(later.status).toBe(409);
    expect((await later.json()).error).toMatch(/^You've had your free day/);
    expect(await codesOf(member.id)).toHaveLength(1);
  });

  it("a pass spent before the doors were one counts as the free day", async () => {
    await ask("hal@example.test", "Hal Early");
    await approve("hal@example.test");
    const member = await memberOf("hal@example.test");
    // The old portal path: the pass spent, a code issued, the claim left reserved.
    await db.sql("update members set day_passes_balance = 0 where id = $1", [member.id]);
    await db.sql("update free_day_claims set created_at = now() - interval '3 days' where email = 'hal@example.test'");
    const hour = new Date(Date.now() - 3600_000).toISOString();
    await seedCode(member.id, "123456", 130, hour, hour);
    await signIn("hal@example.test");
    const res = await activateRoute();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^You've had your free day/);
    expect((await claimOf("hal@example.test")).status).toBe("activated");
    expect(await codesOf(member.id)).toHaveLength(1);
  });
});

describe("members can't claim", () => {
  beforeEach(async () => {
    // Mia's row keeps the case she signed up with: the check matches it anyway.
    await db.sql("insert into members (name, email, member_type) values ('Mia Member', 'Mia@Example.test', 'day_pass')");
    await db.sql(`insert into subscriptions (member_id, payment_rail, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_key, monthly_cents, status)
      values ((select id from members where email = 'Mia@Example.test'), 'stripe', 'sub_mia', 'cus_mia', 'price_mia', 'member_basic', 3000, 'active')`);
  });

  it("signed in, a member on a $30 plan is told their code is on the portal, and no claim is written", async () => {
    await signIn("mia@example.test");
    const res = await ask("mia@example.test", "Mia Member");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: ALREADY_MEMBER, already_member: true });
    expect(await claimOf("mia@example.test")).toBeUndefined();
  });

  it("signed out, the page answers as for anyone (no membership leak); the address's owner is told by email", async () => {
    const res = await ask("mia@example.test", "Mia Member");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ submitted: true, authenticated: false, status: "pending" });
    expect(await claimOf("mia@example.test")).toBeUndefined();
    expect(mailTo("mia@example.test").map((m) => m.subject)).toEqual(["You don't need a free day"]);
    expect(await db.sql("select kind from email_log where email = 'mia@example.test'")).toEqual([{ kind: "free_day_already_member" }]);
    // Sent again and again, it answers the same and mails her once a day, not once a click.
    expect(await (await ask("mia@example.test", "Mia Member")).json()).toEqual({ submitted: true, authenticated: false, status: "pending" });
    expect(mailTo("mia@example.test")).toHaveLength(1);
  });

  it("signed out, someone who already asked gets the same answer as a new request (no 'already claimed' tell)", async () => {
    await ask("zoe@example.test", "Zoe");
    const again = await ask("zoe@example.test", "Zoe");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ submitted: true, authenticated: false, status: "pending" });
    expect(await db.sql("select count(*)::int n from free_day_claims where email = 'zoe@example.test'")).toEqual([{ n: 1 }]);
  });

  it("signed in, nobody claims for another address", async () => {
    await signIn("nia@example.test");
    const res = await ask("someone.else@example.test", "Nia");
    expect(res.status).toBe(400);
    expect(await claimOf("someone.else@example.test")).toBeUndefined();
  });

  it("a member signed in can't claim with another address", async () => {
    await db.sql("update members set supabase_user_id = null where email = 'Mia@Example.test'");
    await signIn("mia@example.test");
    await db.sql("update members set supabase_user_id = $1 where email = 'Mia@Example.test'", [signedIn!.id]);
    const res = await ask("mia.other@example.test", "Mia Member");
    expect(res.status).toBe(409);
    expect(await claimOf("mia.other@example.test")).toBeUndefined();
  });

  it("a hot desk too; a day-pass buyer with no plan may still claim", async () => {
    await db.sql(`insert into members (name, email, member_type) values ('Hu Desk', 'hu@example.test', 'hot_desk'),
      ('Bo Buyer', 'bo@example.test', 'day_pass')`);
    await ask("hu@example.test", "Hu Desk");
    expect(await claimOf("hu@example.test")).toBeUndefined();
    expect((await ask("bo@example.test", "Bo Buyer")).status).toBe(200);
    expect((await claimOf("bo@example.test")).status).toBe("pending");
  });
});

describe("an unused free day lapses", () => {
  it(`${FREE_DAY_LAPSE_DAYS} days after approval: expired, pass taken back, and asking again reopens the same row`, async () => {
    await ask("lu@example.test", "Lu Late");
    await approve("lu@example.test");
    await ask("ed@example.test", "Ed Early");
    await approve("ed@example.test");
    await ask("new@example.test", "Nia New");
    await approve("new@example.test");
    const old = new Date(Date.now() - (FREE_DAY_LAPSE_DAYS + 1) * DAY).toISOString();
    await db.sql("update free_day_claims set created_at = $1, approved_at = $1 where email in ('lu@example.test', 'ed@example.test')", [old]);
    // Asked long ago but approved only lately: the 90 days run from approval (migration 071), so it doesn't lapse.
    await db.sql("update free_day_claims set created_at = $1 where email = 'new@example.test'", [old]);
    // Lu's one code attempt failed at the lock (revoked, pass refunded): that was never a free day.
    const lu = await memberOf("lu@example.test");
    const luDay = new Date(Date.parse(old) + 2 * DAY).toISOString();
    await seedCode(lu.id, "111222", 132, luDay, luDay, true);
    // Ed used the pass on Day passes before the doors were one: a code since the claim. Ed had the free day.
    const ed = await memberOf("ed@example.test");
    await db.sql("update members set day_passes_balance = 0 where id = $1", [ed.id]);
    const edDay = new Date(Date.parse(old) + 5 * DAY).toISOString();
    await seedCode(ed.id, "654321", 131, edDay, edDay);

    expect(await lapseFreeDays(db as never)).toEqual({ lapsed: 1, used: 1 });
    expect((await claimOf("lu@example.test")).status).toBe("expired");
    expect((await memberOf("lu@example.test")).day_passes_balance).toBe(0);
    expect((await claimOf("ed@example.test")).status).toBe("activated");
    expect((await claimOf("new@example.test")).status).toBe("reserved");
    const audit = await db.sql<{ payload: { pass_taken_back: boolean } }>("select payload from admin_actions where action = 'free_day_lapsed'");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload.pass_taken_back).toBe(true);
    expect(await lapseFreeDays(db as never)).toEqual({ lapsed: 0, used: 0 });

    // Lu asks again: the same row, pending, dated now; approval gives one pass, not two.
    const before = await claimOf("lu@example.test");
    expect((await ask("lu@example.test", "Lu Late")).status).toBe(200);
    const reopened = await claimOf("lu@example.test");
    expect(reopened).toMatchObject({ id: before.id, status: "pending", day_code_id: null });
    expect(Date.parse(reopened.created_at)).toBeGreaterThan(Date.parse(old));
    await approve("lu@example.test");
    expect((await memberOf("lu@example.test")).day_passes_balance).toBe(1);
    // Ed had the free day: asking again (signed out) answers as for anyone, and changes nothing.
    expect((await ask("ed@example.test", "Ed Early")).status).toBe(200);
    expect((await claimOf("ed@example.test")).status).toBe("activated");
  });

  it("before migration 071 nothing lapses (no approval time to count from), and nothing breaks", async () => {
    db = await makePgDb({ before: "071" });
    vi.mocked(createServiceClient).mockReturnValue({ ...db, auth: { signInWithOtp: async () => ({ error: null }) } } as never);
    await ask("old@example.test", "Ola Old");
    await approve("old@example.test");
    await db.sql("update free_day_claims set created_at = now() - interval '200 days' where email = 'old@example.test'");
    expect(await lapseFreeDays(db as never)).toEqual({ lapsed: 0, used: 0, waitingFor: "071_free_day_approved_at.sql" });
    expect((await claimOf("old@example.test")).status).toBe("reserved");
  });
});

describe("the emails a claim gets", () => {
  it("'got it' when it needs review, a kind note when declined, each logged", async () => {
    await ask("dee@example.test", "Dee Declined");
    const [{ id }] = await db.sql<{ id: number }>("select id from free_day_claims where email = 'dee@example.test'");
    const res = await adminClaims(new Request("http://x/api/admin/claims", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status: "cancelled" }),
    }));
    expect(res.status).toBe(200);
    const subjects = mailTo("dee@example.test").map((m) => m.subject).sort();
    expect(subjects).toEqual(["About your free day request", "We got your free day request"]);
    const log = await db.sql<{ kind: string; status: string }>("select kind, status from email_log where email = 'dee@example.test' order by id");
    expect(log).toEqual([{ kind: "free_day_received", status: "sent" }, { kind: "free_day_declined", status: "sent" }]);
    // A second click doesn't send it twice.
    await adminClaims(new Request("http://x/api/admin/claims", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status: "cancelled" }),
    }));
    expect(mailTo("dee@example.test")).toHaveLength(2);
  });

  it("no '$' typed into the free-day emails: prices come from the shared catalog", async () => {
    const shared = await import("@regenhub/shared");
    const t = shared.membershipApprovedEmail({ name: "Pat", siteUrl: "https://x" });
    expect(t.text).toContain(`${shared.dollars(shared.PLAN_MONTHLY_CENTS.member_basic)} a month`);
    const { readFile } = await import("node:fs/promises");
    for (const f of ["../../packages/shared/src/freeDayEmails.ts", "../bot/src/email.ts"]) {
      const src = await readFile(new URL(f, `file://${process.cwd()}/`), "utf8");
      expect(src, f).not.toMatch(/\$\d/);
    }
  });
});
