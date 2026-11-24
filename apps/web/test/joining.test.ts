/**
 * One way to join (T-482 round 5): apply, one member vouches, one approval, then a day plan; desks on request.
 * Real routes on a real schema (PGlite with every migration, 072 included); the staging outbox as the mail provider.
 * Faked: Stripe (its checkout) and the Telegram API (fetch to api.telegram.org), both outside our control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { makePgDb, type PgDb } from "./pgDb";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stripe")>(),
  isStripeConfigured: () => true,
  getOrCreateCustomer: async () => ({ id: "cus_test" }),
  getStripe: () => ({ checkout: { sessions: { create: async () => ({ id: "cs_test", url: "https://checkout.stripe.test/s" }) } } }),
}));

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { POST as applyRoute } from "@/app/api/portal/application/route";
import { POST as vouchRoute } from "@/app/api/portal/applications/[id]/vouch/route";
import { POST as approveRoute } from "@/app/api/admin/applications/[id]/approve/route";
import { PATCH as statusRoute } from "@/app/api/admin/applications/route";
import { PATCH as switchRoute } from "@/app/api/admin/members/[id]/approve-membership/route";
import { POST as subscribeRoute } from "@/app/api/membership/subscribe/route";
import { POST as deskAskRoute } from "@/app/api/portal/desk-ask/route";
import { POST as claimRoute } from "@/app/api/freeday/route";
import { GET as searchRoute } from "@/app/api/portal/members/search/route";
import { approveApplication, repostWaitingCards, type ChatCard } from "@regenhub/shared";
import { approvalOf } from "@/lib/approval";
import { freeDayDecision, whoKnows, LIST_DAYS } from "@/lib/freeDayRule";
import { lateItems } from "@/lib/adminQueue";
import { stagingOutboxMails } from "@/lib/staging/outbox";

const HOUR = 3_600_000;
let db: PgDb;
let signedIn: { id: string; email: string } | null = null;
let chat: { method: string; body: Record<string, unknown> }[] = [];

const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

/** Members: an ops admin (desks), a plain admin, a member in standing, a day-pass person (not a member). */
async function seed() {
  await db.sql(`insert into auth.users(id, email) values ($1,'ana@hub.test'),($2,'bo@hub.test'),($3,'carey@hub.test'),($4,'dan@x.test'),($5,'pat@x.test')`,
    [uid(1), uid(2), uid(3), uid(4), uid(5)]);
  await db.sql(`insert into members(id, name, email, member_type, is_admin, is_ops_admin, supabase_user_id, telegram_username) values
    (1, 'Ana Admin', 'ana@hub.test', 'hot_desk', true, true, $1, 'ana_hub'),
    (2, 'Bo Steward', 'bo@hub.test', 'hub_friend', true, false, $2, null),
    (3, 'Carey Member', 'carey@hub.test', 'hub_friend', false, false, $3, 'carey_hub'),
    (4, 'Dan Daypass', 'dan@x.test', 'day_pass', false, false, $4, null)`, [uid(1), uid(2), uid(3), uid(4)]);
  await db.sql(`select setval('members_id_seq', 100)`);
}
const as = (n: number, email: string) => { signedIn = { id: uid(n), email }; };

beforeEach(async () => {
  db = await makePgDb();
  signedIn = null;
  chat = [];
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
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_GROUP_CHAT_ID", "-100");
  // Telegram is the one network call here: record each, answer like the Bot API.
  let nextMessage = 500;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    chat.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: nextMessage++ } : true }));
  }));
  await seed();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.close();
});

async function apply(knownBy: number | null) {
  as(5, "pat@x.test");
  const res = await applyRoute(new Request("http://x/api/portal/application", json({
    name: "Pat Newcomer", about: "Soil sensors", how_found: "A friend", known_by_member_id: knownBy,
  })));
  expect(res.status).toBe(200);
  const [app] = await db.sql<{ id: number }>(`select id from applications where email = 'pat@x.test'`);
  await vi.waitFor(() => expect(chat.some((c) => c.method === "sendMessage")).toBe(true));
  return app.id;
}

describe("apply → vouch → approve", () => {
  it("the short form saves who knows them, posts one chat card asking for a vouch, and says we reply within a day", async () => {
    const id = await apply(3);
    const [row] = await db.sql(`select known_by_member_id, how_found, status, chat_message_id from applications where id = $1`, [id]);
    expect(row).toMatchObject({ known_by_member_id: 3, how_found: "A friend", status: "pending", chat_message_id: 500 });
    const card = chat.find((c) => c.method === "sendMessage")!.body;
    expect(String(card.text)).toContain("Carey Member (@carey\\_hub) knows them");
    expect(JSON.stringify(card.reply_markup)).toContain(`app_vouch_${id}`);
    expect(JSON.stringify(card.reply_markup)).not.toContain("app_approve_");
    await vi.waitFor(() => expect(stagingOutboxMails().some((m) => m.to === "pat@x.test")).toBe(true));
    const ack = stagingOutboxMails().find((m) => m.to === "pat@x.test");
    expect(ack?.html).toContain("We reply within a day");
    expect(ack?.html).toContain("asked Carey Member to vouch");
  });

  it("can't be approved without a vouch, from the site or the chat's function", async () => {
    const id = await apply(null);
    as(1, "ana@hub.test");
    const res = await approveRoute(new Request("http://x", { method: "POST" }), params(id));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("no_vouch");
    const viaChat = await approveApplication(db, { applicationId: id, approverMemberId: 1, via: "chat", siteUrl: "http://x", send: async () => true });
    expect(viaChat).toMatchObject({ ok: false, reason: "no_vouch" });
    // Nor by setting the status by hand.
    const patch = await statusRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ id, status: "approved" }) }));
    expect(patch.status).toBe(400);
    const [row] = await db.sql(`select status from applications where id = $1`, [id]);
    expect(row.status).toBe("pending");
  });

  it("a vouch by someone who isn't a member is refused; so is vouching for yourself", async () => {
    const id = await apply(null);
    as(4, "dan@x.test");
    const res = await vouchRoute(new Request("http://x", { method: "POST" }), params(id));
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("not_a_member");
    const [row] = await db.sql(`select vouched_by from applications where id = $1`, [id]);
    expect(row.vouched_by).toBeNull();
    // The applicant's own member row (if they had one in standing) still can't vouch for them.
    await db.sql(`insert into members(name, email, member_type, supabase_user_id) values ('Pat', 'pat@x.test', 'hub_friend', $1)`, [uid(5)]);
    as(5, "pat@x.test");
    const self = await vouchRoute(new Request("http://x", { method: "POST" }), params(id));
    expect((await self.json()).reason).toBe("own_application");
  });

  it("the named member vouches from the portal, the card turns to Approve, and a steward approves: one member, one email, audited", async () => {
    const id = await apply(3);
    as(3, "carey@hub.test");
    const v = await vouchRoute(new Request("http://x", { method: "POST" }), params(id));
    expect(v.status).toBe(200);
    const edit = chat.find((c) => c.method === "editMessageText")!.body;
    expect(edit.message_id).toBe(500);
    expect(String(edit.text)).toContain("Vouched for by Carey Member");
    expect(JSON.stringify(edit.reply_markup)).toContain(`app_approve_${id}`);

    // A member who isn't a steward can't approve.
    expect((await approveApplication(db, { applicationId: id, approverMemberId: 3, via: "chat", siteUrl: "http://x", send: async () => true }))
      .ok).toBe(false);

    as(2, "bo@hub.test");
    const res = await approveRoute(new Request("http://x", { method: "POST" }), params(id));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ approved: true, email_sent: true, email_to: "pat@x.test" });
    const [m] = await db.sql(`select * from members where email = 'pat@x.test'`);
    expect(approvalOf(m)).toMatchObject({ member: true, desk: false, memberBy: 2 });
    expect(m.approved_for_daily).toBe(true); // the old flag follows for one release (072's mirror)
    const audit = await db.sql(`select action, payload from admin_actions where action in ('application_vouched','membership_approved') order by id`);
    expect(audit.map((a) => a.action)).toEqual(["application_vouched", "membership_approved"]);
    expect(audit[1].payload).toMatchObject({ application_id: id, vouched_by: 3, via: "site" });
    expect(stagingOutboxMails().filter((x) => x.subject.includes("pick your plan"))).toHaveLength(1);
    // Approving again changes nothing and sends nothing.
    await approveRoute(new Request("http://x", { method: "POST" }), params(id));
    expect(stagingOutboxMails().filter((x) => x.subject.includes("pick your plan"))).toHaveLength(1);
  });

  it("the bot and the admin page approve through the same function", async () => {
    const bot = await readFile(new URL("../../bot/src/bot.ts", import.meta.url), "utf8");
    const web = await readFile(new URL("../src/app/api/admin/applications/[id]/approve/route.ts", import.meta.url), "utf8");
    for (const src of [bot, web]) {
      expect(src).toMatch(/import \{[^}]*\bapproveApplication\b[^}]*\} from "@regenhub\/shared"/);
      expect(src).toMatch(/await approveApplication\(/);
    }
    // Nothing else turns the approval on: the one SQL function, and desk access (which implies it, lib/approval.ts).
    const files = [
      ...await walk(new URL("../src/", import.meta.url)),
      ...await walk(new URL("../../bot/src/", import.meta.url)),
      ...await walk(new URL("../../../packages/shared/src/", import.meta.url)),
    ].filter((f) => !f.includes(".test."));
    for (const f of files) {
      const src = await readFile(f, "utf8");
      if (f.endsWith("/lib/approval.ts")) continue; // deskAccessUpdate: desk access implies the approval
      expect(src, f).not.toMatch(/approved_for_daily:\s*true/);
      if (f.endsWith("/lib/approval.ts")) continue;
      expect(src, f).not.toMatch(/member_approved:\s*true/);
    }
  });
});

async function walk(dir: URL): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const u = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
    if (e.isDirectory()) out.push(...await walk(u));
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(u.pathname);
  }
  return out;
}

describe("day plans for every approved member, desks only with desk access", () => {
  async function approvedPat() {
    const id = await apply(3);
    as(3, "carey@hub.test");
    await vouchRoute(new Request("http://x", { method: "POST" }), params(id));
    as(2, "bo@hub.test");
    await approveRoute(new Request("http://x", { method: "POST" }), params(id));
    const [m] = await db.sql<{ id: number }>(`select id from members where email = 'pat@x.test'`);
    return m.id;
  }
  const subscribe = (plan: string) => subscribeRoute(new Request("http://x", json({ plan_key: plan })));

  it("before approval nothing; after it each day plan; a desk only once a desk steward turns access on", async () => {
    as(4, "dan@x.test");
    expect((await subscribe("member_basic")).status).toBe(403);

    const patId = await approvedPat();
    as(5, "pat@x.test");
    for (const plan of ["member_basic", "member_2day", "member_5day"]) {
      const res = await subscribe(plan);
      expect(res.status, plan).toBe(200);
      expect((await res.json()).url).toBe("https://checkout.stripe.test/s");
    }
    const desk = await subscribe("hot_desk");
    expect(desk.status).toBe(403);
    expect((await desk.json()).error).toMatch(/ask about one from your portal/);

    // They ask from the portal: recorded once, posted to the chat.
    const ask = await deskAskRoute();
    expect(ask.status).toBe(200);
    expect(chat.some((c) => String(c.body.text).includes("Desk ask:* Pat Newcomer"))).toBe(true);

    // A steward who isn't an ops admin can't turn desk access on; one who is can.
    as(2, "bo@hub.test");
    const refused = await switchRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ level: "desk", approved: true }) }), params(patId));
    expect(refused.status).toBe(403);
    as(1, "ana@hub.test");
    const on = await switchRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ level: "desk", approved: true }) }), params(patId));
    expect(on.status).toBe(200);
    as(5, "pat@x.test");
    expect((await subscribe("hot_desk")).status).toBe(200);
    expect((await subscribe("cold_desk")).status).toBe(200);
  });
});

describe("migration 072 keeps everyone's access", () => {
  it("old daily/full approvals become member/desk, and the two pairs stay equal whichever side writes", async () => {
    const old = await makePgDb({ before: "072" });
    try {
      await old.sql(`insert into members(id, name, email, member_type, approved_for_daily, approved_for_daily_at, approved_for_full, approved_for_full_at) values
        (1, 'Daily', 'd@x.test', 'day_pass', true, '2026-05-01', false, null),
        (2, 'Desk', 'k@x.test', 'hot_desk', true, '2026-04-01', true, '2026-04-02'),
        (3, 'Neither', 'n@x.test', 'day_pass', false, null, false, null)`);
      const dir = new URL("../../../supabase/migrations/", import.meta.url);
      const file = (await readdir(dir)).find((f) => f.startsWith("072_"))!;
      await old.exec(await readFile(new URL(file, dir), "utf8"));
      const rows = await old.sql(`select id, member_approved, desk_access, member_approved_at from members order by id`);
      expect(rows.map((r) => [r.id, r.member_approved, r.desk_access])).toEqual([[1, true, false], [2, true, true], [3, false, false]]);
      expect(String(rows[0].member_approved_at)).toContain("2026-05-01");
      // An old writer (a bot still running the last release) sets only the old flag: the new one follows.
      await old.sql(`update members set approved_for_full = true where id = 1`);
      // New code takes approval back: the old flags follow.
      await old.sql(`update members set member_approved = false, desk_access = false where id = 2`);
      const after = await old.sql(`select id, member_approved, desk_access, approved_for_daily, approved_for_full from members where id in (1,2) order by id`);
      expect(after).toEqual([
        { id: 1, member_approved: true, desk_access: true, approved_for_daily: true, approved_for_full: true },
        { id: 2, member_approved: false, desk_access: false, approved_for_daily: false, approved_for_full: false },
      ]);
    } finally {
      await old.close();
    }
  });
});

describe("the free-day rule", () => {
  it("approves at once whom we know (a night, an invite, the list for a week) and nobody else; one constant flips it", async () => {
    const now = new Date();
    await db.sql(`insert into night_followup_batches(id, event_uri, event_name, decision, decided_by_did) values (1, 'at://e/1', 'Night', 'send', 'did:plc:x')`);
    await db.sql(`insert into night_followups(batch_id, event_uri, email, variant, status) values (1, 'at://e/1', 'night@x.test', 'guest', 'sent')`);
    await db.sql(`insert into interests(email, created_at) values ('old@x.test', $1), ('new@x.test', $2), ('gone@x.test', $1)`,
      [new Date(now.getTime() - (LIST_DAYS + 1) * 24 * HOUR).toISOString(), new Date(now.getTime() - 2 * 24 * HOUR).toISOString()]);
    await db.sql(`insert into email_unsubscribes(email) values ('gone@x.test')`);
    const admin = createServiceClient();

    expect(await whoKnows(admin, { email: "Night@x.test" })).toEqual({ kind: "night" });
    expect(await whoKnows(admin, { email: "who@x.test", inviter: { name: "Carey" } })).toEqual({ kind: "invite", inviter: "Carey" });
    expect((await whoKnows(admin, { email: "old@x.test" }))?.kind).toBe("list");
    expect(await whoKnows(admin, { email: "new@x.test" })).toBeNull();
    expect(await whoKnows(admin, { email: "gone@x.test" })).toBeNull();
    expect(await whoKnows(admin, { email: "stranger@x.test" })).toBeNull();

    expect(freeDayDecision({ kind: "night" })).toBe("approve");
    expect(freeDayDecision(null)).toBe("review");
    expect(freeDayDecision(null, "always")).toBe("approve");
    expect(freeDayDecision({ kind: "night" }, "never")).toBe("review");
  });

  it("through the claim form: a known person's free day is approved with its email, a stranger's waits for one tap", async () => {
    await db.sql(`insert into night_followup_batches(id, event_uri, event_name, decision, decided_by_did) values (1, 'at://e/1', 'Night', 'send', 'did:plc:x')`);
    await db.sql(`insert into night_followups(batch_id, event_uri, email, variant, status) values (1, 'at://e/1', 'night@x.test', 'guest', 'sent')`);
    const form = (email: string) => claimRoute(new Request("http://x", json({ name: "Guest", email, about: "Things", why_join: "Curious" })));
    const r1 = await form("night@x.test");
    expect(r1.status, JSON.stringify(await r1.clone().json())).toBe(200);
    expect((await form("stranger@x.test")).status).toBe(200);
    const rows = await db.sql(`select email, status, approved_by from free_day_claims order by email`);
    expect(rows).toEqual([
      { email: "night@x.test", status: "reserved", approved_by: "auto: RSVP'd to one of our nights" },
      { email: "stranger@x.test", status: "pending", approved_by: null },
    ]);
    expect(stagingOutboxMails().find((m) => m.to === "night@x.test")?.subject).toBe("Your free day at RegenHub is ready");
    expect(stagingOutboxMails().find((m) => m.to === "stranger@x.test")?.subject).toBe("We got your free day request");
    const cards = chat.filter((c) => c.method === "sendMessage").map((c) => c.body);
    expect(cards.find((c) => String(c.text).includes("night@x.test"))?.reply_markup).toBeUndefined();
    expect(JSON.stringify(cards.find((c) => String(c.text).includes("stranger@x.test"))?.reply_markup)).toContain("freeday_approve_");
  });
});

describe("we answer within a day", () => {
  it("a waiting card is re-posted once at 12 hours, never twice, and not for old or fresh ones", async () => {
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * HOUR).toISOString();
    await db.sql(`insert into applications(email, name, status, created_at) values
      ('a13@x.test', 'Thirteen', 'pending', $1), ('a2@x.test', 'Two', 'pending', $2), ('a100@x.test', 'Old', 'pending', $3),
      ('done@x.test', 'Done', 'approved', $1)`, [ago(13), ago(2), ago(100)]);
    await db.sql(`insert into free_day_claims(email, name, status, created_at) values ('f13@x.test', 'Claim', 'pending', $1)`, [ago(13)]);
    const posted: ChatCard[] = [];
    const post = async (c: ChatCard) => { posted.push(c); return 700 + posted.length; };
    expect(await repostWaitingCards(db, now, post)).toEqual({ applications: 1, freeDays: 1 });
    expect(posted.map((c) => c.text.split("\n")[0])).toEqual(["⏰ *Still waiting* (13 h). We answer within a day.", "⏰ *Still waiting* (13 h). We answer within a day."]);
    expect(await repostWaitingCards(db, new Date(now.getTime() + HOUR), post)).toEqual({ applications: 0, freeDays: 0 });
    expect(posted).toHaveLength(2);
    const [app] = await db.sql(`select chat_message_id from applications where email = 'a13@x.test'`);
    expect(app.chat_message_id).toBe(701); // site-side vouches now edit the newest card
  });

  it("Today lists anything over 24 hours as late, oldest first, with its age", () => {
    const now = Date.parse("2026-11-24T18:00:00Z");
    const items = lateItems([
      { kind: "application", id: 1, name: "Pat", createdAt: "2026-11-23T11:00:00Z" },
      { kind: "free day", id: 2, name: "Lee", createdAt: "2026-11-21T18:00:00Z" },
      { kind: "application", id: 3, name: "Sam", createdAt: "2026-11-24T08:00:00Z" },
    ], now);
    expect(items.map((i) => i.label)).toEqual([
      "Late: Lee's free-day request, waiting 3 days",
      "Late: Pat's application, waiting 31 h",
    ]);
    expect(items.every((i) => i.urgent)).toBe(true);
  });
});

describe("the type-ahead", () => {
  it("offers members who can vouch (names only), never non-members or the person asking", async () => {
    as(5, "pat@x.test");
    const res = await searchRoute(new Request("http://x/api/portal/members/search?q=a"));
    expect((await res.json()).members).toEqual([]); // two letters at least
    const found = await (await searchRoute(new Request("http://x/api/portal/members/search?q=an"))).json();
    expect(found.members).toEqual([{ id: 1, name: "Ana Admin" }]); // "Dan Daypass" matches too, but isn't a member
    const d = await (await searchRoute(new Request("http://x/api/portal/members/search?q=da"))).json();
    expect(d.members).toEqual([]); // Dan is on day passes: not a member
    signedIn = null;
    expect((await searchRoute(new Request("http://x/api/portal/members/search?q=an"))).status).toBe(401);
  });
});

describe("one name per thing", () => {
  it("no 'Full Access', 'daily approval' or 'full approval' left in the app, the emails or the bot", async () => {
    const files = [
      ...await walk(new URL("../src/", import.meta.url)),
      ...await walk(new URL("../../bot/src/", import.meta.url)),
      ...await walk(new URL("../../../packages/shared/src/", import.meta.url)),
    ];
    for (const f of files) {
      const src = await readFile(f, "utf8");
      expect(src, f).not.toMatch(/Full Access|[Dd]aily approval|[Ff]ull approval/);
    }
  });
});
