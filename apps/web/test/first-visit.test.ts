/**
 * First visits (T-482): real routes on a real schema (PGlite with every migration), the staging outbox as the mail
 * provider. Faked: the door locks (Home Assistant), Telegram's API (the members' chat), and the clock.
 *
 *   - a free-day guest's first door entry posts once to the members' chat, naming who invited them; a second entry
 *     doesn't; the message holds no code, email or phone;
 *   - an entry written long after it happened (a backfill) doesn't post; a long-standing member with earlier entries
 *     doesn't; a member's guest code doesn't;
 *   - before migration 073 the door entry is logged and nothing is posted;
 *   - "I'm coming Thursday" is stored and posts once; the 7 AM email goes once that morning;
 *   - the "who's usually here" sentence from fixture entries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "./pgDb";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  setUserCode: vi.fn(async () => [{ entity: "lock.front_door_lock", ok: true }]),
}));

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { POST as claimRoute } from "@/app/api/freeday/route";
import { POST as activateRoute } from "@/app/api/freeday/activate/route";
import { POST as accessEvent } from "@/app/api/access-events/route";
import { POST as planRoute } from "@/app/api/freeday/plan/route";
import { POST as morningCron } from "@/app/api/cron/free-day-mornings/route";
import { forgetUsuallyHere, welcomeFirstVisit } from "@/lib/firstVisit";
import { stagingOutboxMails } from "@/lib/staging/outbox";
import { planDays, usuallyHereFromEntries, weekdayArrivals } from "@regenhub/shared";

const DAY = 86_400_000;
let db: PgDb;
let signedIn: { id: string; email: string } | null = null;
let chat: string[] = [];

/** A Wednesday at 11am Denver (18:00 UTC in winter): activation needs a weekday; Thursday is the day after. */
const WEDNESDAY = new Date("2026-12-02T18:00:00Z");

async function setup(before?: string) {
  db = await makePgDb(before ? { before } : {});
  vi.mocked(createServiceClient).mockReturnValue({ ...db, auth: { signInWithOtp: async () => ({ error: null }) } } as never);
}

beforeEach(async () => {
  await setup();
  signedIn = null;
  chat = [];
  forgetUsuallyHere();
  vi.mocked(createClient).mockImplementation(async () => ({
    auth: { getUser: async () => ({ data: { user: signedIn }, error: null }) },
    from: (t: string) => db.from(t),
  }) as never);
  (globalThis as { __regenhubStagingOutbox?: unknown[] }).__regenhubStagingOutbox = [];
  vi.stubEnv("EMAIL_PROVIDER", "outbox");
  vi.stubEnv("EMAIL_FROM", "RegenHub <hello@regenhub.test>");
  vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:18700");
  vi.stubEnv("HA_WEBHOOK_SECRET", "ha-secret");
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "bot-token");
  vi.stubEnv("TELEGRAM_GROUP_CHAT_ID", "-100123");
  // Telegram is the one outside service here: capture what the members' chat would get.
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.telegram.org/")) {
      chat.push(JSON.parse(String(init?.body)).text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return real(input, init);
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(WEDNESDAY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const json = (body: unknown, auth?: string) => new Request("http://127.0.0.1:18700/api", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  body: JSON.stringify(body),
});

async function signIn(email: string) {
  const id = `00000000-0000-0000-0000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
  await db.sql("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, email]);
  signedIn = { id, email };
}

/** Rosa (a co-op owner) invites Sam; Sam signs in and gets the free-day code. Returns the code and its slot. */
async function samGetsCode() {
  await db.sql(`insert into members (name, email, member_type, is_coop_member, invite_code)
    values ('Rosa Owner', 'rosa@example.test', 'cold_desk', true, 'ROSA1')`);
  const asked = await claimRoute(json({ name: "Sam Visitor", email: "sam@example.test", invite_code: "ROSA1", telegram: "samv" }));
  expect(asked.status).toBe(200);
  await signIn("sam@example.test");
  const res = await activateRoute();
  expect(res.status).toBe(200);
  const { code } = await res.json();
  const [{ pin_slot }] = await db.sql<{ pin_slot: number }>("select pin_slot from day_codes where code = $1", [code]);
  return { code: code as string, slot: pin_slot };
}

/** Door-code rows (and member PIN slots) are written only inside a PIN-writer reservation, as the schema requires. */
async function asWriter(statement: string) {
  await db.exec(`select acquire_lock_writer('0000000a-0000-4000-8000-00000000beef');
    select set_config('request.headers', '{"x-lock-writer-token":"0000000a-0000-4000-8000-00000000beef"}', false);
    ${statement};
    select set_config('request.headers', '{}', false);
    select release_lock_writer('0000000a-0000-4000-8000-00000000beef');`);
}

const enter = (slot: number) => accessEvent(json({ method: "pin", slot, result: "granted" }, "ha-secret"));

describe("the members' chat hears a first visit", () => {
  it("a free-day guest's first entry posts once, with who invited them; a second entry doesn't", async () => {
    const { code, slot } = await samGetsCode();
    chat = []; // the activation's own note isn't this feature

    const first = await enter(slot);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, attributed: true, first_visit: true });
    expect(chat).toEqual([
      "👋 Sam just came in for their first day (free day). Invited by Rosa Owner. Anyone around to say hi?",
    ]);
    // Nothing that opens the door or reaches the person.
    expect(chat[0]).not.toContain(code);
    expect(chat[0]).not.toMatch(/@|example\.test|samv|\d{3}/);

    vi.setSystemTime(new Date(WEDNESDAY.getTime() + 60_000));
    expect(await (await enter(slot)).json()).toMatchObject({ ok: true, first_visit: false });
    expect(chat).toHaveLength(1);
    expect(await db.sql("select person_key, kind, status from first_visit_alerts")).toEqual([
      { person_key: expect.stringMatching(/^member:\d+$/), kind: "free_day", status: "sent" },
    ]);
  });

  it("both doors logging the same arrival at once post once", async () => {
    const { slot } = await samGetsCode();
    chat = [];
    await Promise.all([enter(slot), enter(slot)]);
    expect(chat).toHaveLength(1);
  });

  it("an entry backfilled more than 15 minutes after it happened doesn't post", async () => {
    const { slot } = await samGetsCode();
    chat = [];
    const [member] = await db.sql<{ id: number }>("select id from members where email = 'sam@example.test'");
    const [row] = await db.sql<{ id: number; created_at: string }>(
      `insert into access_logs (method, slot, member_id, result, created_at)
       values ('pin', $1, $2, 'granted', now() - interval '20 minutes') returning id, created_at`, [slot, member.id]);
    const outcome = await welcomeFirstVisit(db as never, { id: row.id, member_id: member.id, slot, result: "granted", created_at: row.created_at });
    expect(outcome).toEqual({ posted: false, why: "backfill" });
    expect(chat).toEqual([]);
  });

  it("a long-standing member with earlier entries doesn't post, nor does their guest's code", async () => {
    await asWriter(`insert into members (name, email, member_type, pin_code_slot, created_at)
      values ('Old Timer', 'old@example.test', 'hot_desk', 7, now() - interval '3 years')`);
    const [{ id }] = await db.sql<{ id: number }>("select id from members where email = 'old@example.test'");
    await db.sql(`insert into access_logs (method, slot, member_id, result, created_at)
      values ('pin', 7, $1, 'granted', now() - interval '2 years')`, [id]);
    expect(await (await enter(7)).json()).toMatchObject({ attributed: true, first_visit: false });

    // A guest code the member made (label "Guest by …"): the entry is logged under the member, and isn't a first visit.
    await asWriter(`insert into day_codes (member_id, label, code, pin_slot, expires_at, issued_at, is_active)
        values (${id}, 'Guest by Old Timer', '424242', 150, now() + interval '1 day', now() - interval '1 hour', true)`);
    await db.sql("delete from access_logs");
    expect(await (await enter(150)).json()).toMatchObject({ first_visit: false });
    expect(chat).toEqual([]);
  });

  it("an unattributed unlock (the HA poll writes no slot) says nothing", async () => {
    const res = await accessEvent(json({ method: "pin", result: "granted" }, "ha-secret"));
    expect(await res.json()).toMatchObject({ ok: true, attributed: false, first_visit: false });
    expect(chat).toEqual([]);
  });
});

describe("before migration 073", () => {
  it("the entry is logged and nothing is posted", async () => {
    await setup("073");
    const { slot } = await samGetsCode();
    chat = [];
    const res = await enter(slot);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, first_visit: false });
    expect(chat).toEqual([]);
    expect(await db.sql("select count(*)::int n from access_logs")).toEqual([{ n: 1 }]);
  }, 30_000);
});

describe("I'm coming <day>", () => {
  async function approvedSam() {
    await db.sql(`insert into members (name, email, member_type, is_coop_member, invite_code)
      values ('Rosa Owner', 'rosa@example.test', 'cold_desk', true, 'ROSA1')`);
    await claimRoute(json({ name: "Sam Visitor", email: "sam@example.test", invite_code: "ROSA1" }));
    await signIn("sam@example.test");
    chat = [];
  }

  it("is stored and posts once; the same day again posts nothing", async () => {
    await approvedSam();
    const thursday = planDays(WEDNESDAY).find((d) => d.date === "2026-12-03")!;
    expect(thursday.short).toBe("Tomorrow");

    const res = await planRoute(json({ day: thursday.date }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ planned_day: "2026-12-03", posted: true });
    expect(chat).toEqual(["📅 Sam plans to come in tomorrow for their free day. Anyone around then?"]);
    expect(await db.sql("select planned_day, plan_posts from free_day_claims")).toEqual([{ planned_day: "2026-12-03", plan_posts: 1 }]);

    expect(await (await planRoute(json({ day: thursday.date }))).json()).toEqual({ planned_day: "2026-12-03", posted: false });
    expect(chat).toHaveLength(1);

    // A change is posted as one; a day not offered is refused.
    expect(await (await planRoute(json({ day: "2026-12-07" }))).json()).toEqual({ planned_day: "2026-12-07", posted: true });
    expect(chat[1]).toBe("📅 Sam now plans to come in Monday, Dec 7 for their free day. Anyone around then?");
    expect((await planRoute(json({ day: "2026-12-05" }))).status).toBe(400); // a Saturday
  });

  it("the 7 AM email goes once that morning, logged", async () => {
    await approvedSam();
    await planRoute(json({ day: "2026-12-03" }));
    const run = () => morningCron(new Request("http://x/api/cron/free-day-mornings", { method: "POST", headers: { Authorization: "Bearer cron-secret" } }));

    vi.setSystemTime(new Date("2026-12-03T13:30:00Z")); // 6:30 AM in Boulder: too early
    expect(await (await run()).json()).toMatchObject({ sent: 0 });
    vi.setSystemTime(new Date("2026-12-03T14:05:00Z")); // 7:05 AM
    expect(await (await run()).json()).toMatchObject({ due: 1, sent: 1 });
    expect(await (await run()).json()).toMatchObject({ due: 0, sent: 0 });

    const mails = stagingOutboxMails().filter((m) => m.subject === "See you at RegenHub today");
    expect(mails).toHaveLength(1);
    expect(mails[0].html).toContain("http://127.0.0.1:18700/freeday");
    expect(await db.sql("select kind, status from email_log where kind = 'free_day_morning'")).toEqual([{ kind: "free_day_morning", status: "sent" }]);
  });
});

describe("who's usually here", () => {
  /** Eight weeks of mornings before WEDNESDAY: Mon–Thu someone in at 7:50, Fridays only twice by 10. */
  function fixture(): string[] {
    const out: string[] = [];
    for (let i = 1; i <= 56; i += 1) {
      const d = new Date(WEDNESDAY.getTime() - i * DAY);
      const wd = d.getUTCDay();
      const date = d.toISOString().slice(0, 10);
      if (wd >= 1 && wd <= 4) out.push(`${date}T14:50:00Z`, `${date}T16:10:00Z`); // 7:50 and 9:10 MST
      if (wd === 5) out.push(i <= 14 ? `${date}T16:30:00Z` : `${date}T19:00:00Z`); // 9:30 twice, else noon
    }
    return out;
  }

  it("gives the plain sentence", () => {
    expect(usuallyHereFromEntries(fixture(), WEDNESDAY)).toBe("Most weekdays someone's in by 8am; Fridays are quieter.");
    const stats = weekdayArrivals(fixture(), WEDNESDAY);
    expect(stats.find((s) => s.weekday === "Fridays")).toMatchObject({ days: 8, inBy10: 2 });
  });

  it("names the busy days when there are few, and says nothing with too little to go on", () => {
    const tueWed = fixture().filter((t) => [2, 3].includes(new Date(t).getUTCDay()));
    expect(usuallyHereFromEntries(tueWed, WEDNESDAY)).toBe("Someone's usually in by 8am on Tuesdays and Wednesdays; other days are quieter.");
    expect(usuallyHereFromEntries(fixture().slice(0, 6), WEDNESDAY)).toBeNull();
  });

  it("is in the approval email", async () => {
    // Seed the fixture as door entries, then approve a claim through the admin route.
    for (const t of fixture()) await db.sql("insert into access_logs (method, result, created_at) values ('pin', 'granted', $1)", [t]);
    const { freeDayApprovedEmail } = await import("@/lib/email");
    const { usuallyHere } = await import("@/lib/firstVisit");
    const line = await usuallyHere(db as never, WEDNESDAY);
    expect(line).toBe("Most weekdays someone's in by 8am; Fridays are quieter.");
    const tpl = freeDayApprovedEmail({ name: "Sam Visitor", siteUrl: "https://regenhub.xyz", usuallyHere: line });
    expect(tpl.html).toContain(line!);
    expect(tpl.text).toContain(line!);
    expect(tpl.text).toContain("Bring your laptop");
  });
});
