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
// The People page's buttons are client components: rendered to HTML here, outside an app router.
vi.mock("next/navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/navigation")>(),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
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
import { POST as customPriceRoute } from "@/app/api/admin/members/[id]/custom-price/route";
import { POST as claimRoute } from "@/app/api/freeday/route";
import { GET as searchRoute } from "@/app/api/portal/members/search/route";
import { approveApplication, approveInChat, handleApprovalTap, repostWaitingCards, type ChatCard } from "@regenhub/shared";
import { PATCH as claimsRoute } from "@/app/api/admin/claims/route";
import PeoplePage from "@/app/admin/people/page";
import { portalViewer } from "@/lib/admin";
import { renderToStaticMarkup } from "react-dom/server";
import { approvalOf } from "@/lib/approval";
import { freeDayDecision, whoKnows, LIST_DAYS } from "@/lib/freeDayRule";
import { lateItems } from "@/lib/adminQueue";
import { welcomeFirstVisit } from "@/lib/firstVisit";
import { stagingOutboxMails } from "@/lib/staging/outbox";

const HOUR = 3_600_000;
let db: PgDb;
let signedIn: { id: string; email: string } | null = null;
let chat: { method: string; body: Record<string, unknown> }[] = [];

const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

/**
 * Members (migration 074: on the site a co-op member approves; in the chat anyone in it):
 *   1 Ana: site admin + ops admin, not co-op     2 Bo: site admin, not co-op
 *   3 Carey: co-op member, not an admin          4 Dan: day passes, nothing else
 *   6 Eve: site admin + co-op, not ops admin (the member page's desk switch)
 */
async function seed() {
  await db.sql(`insert into auth.users(id, email) values ($1,'ana@hub.test'),($2,'bo@hub.test'),($3,'carey@hub.test'),($4,'dan@x.test'),($5,'pat@x.test'),($6,'eve@hub.test')`,
    [uid(1), uid(2), uid(3), uid(4), uid(5), uid(6)]);
  await db.sql(`insert into members(id, name, email, member_type, is_admin, is_ops_admin, is_coop_member, supabase_user_id, telegram_username, telegram_user_id) values
    (1, 'Ana Admin', 'ana@hub.test', 'hot_desk', true, true, false, $1, 'ana_hub', 1001),
    (2, 'Bo Steward', 'bo@hub.test', 'hub_friend', true, false, false, $2, null, null),
    (3, 'Carey Member', 'carey@hub.test', 'hub_friend', false, false, true, $3, 'carey_hub', 1003),
    (4, 'Dan Daypass', 'dan@x.test', 'day_pass', false, false, false, $4, null, null),
    (6, 'Eve Keeper', 'eve@hub.test', 'hub_friend', true, false, true, $5, null, null)`, [uid(1), uid(2), uid(3), uid(4), uid(6)]);
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
    expect(ack?.html).toContain("asked Carey M. to vouch"); // not listed in the directory: first name and initial
  });

  it("only someone who can vouch can be named; applying again after a rejection needs a new vouch", async () => {
    as(5, "pat@x.test");
    const named = await applyRoute(new Request("http://x", json({ name: "Pat", about: "x", known_by_member_id: 4 })));
    expect(named.status).toBe(400); // Dan is on day passes: not someone who can vouch
    const id = await apply(3);
    as(3, "carey@hub.test");
    await vouchRoute(new Request("http://x", { method: "POST" }), params(id));
    // Turning someone down is a co-op member's call too: a site admin who isn't one is refused.
    as(2, "bo@hub.test");
    expect((await statusRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ id, status: "rejected" }) }))).status).toBe(403);
    as(3, "carey@hub.test");
    expect((await statusRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ id, status: "rejected" }) }))).status).toBe(200);
    await apply(3);
    const [row] = await db.sql(`select status, vouched_by, chat_reposted_at from applications where id = $1`, [id]);
    expect(row).toEqual({ status: "pending", vouched_by: null, chat_reposted_at: null });
    as(3, "carey@hub.test");
    expect((await (await approveRoute(new Request("http://x", { method: "POST" }), params(id))).json()).reason).toBe("no_vouch");
  });

  it("can't be approved without a vouch, from the site or the chat's function", async () => {
    const id = await apply(null);
    as(3, "carey@hub.test");
    const res = await approveRoute(new Request("http://x", { method: "POST" }), params(id));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("no_vouch");
    const viaChat = await approveApplication(db, { applicationId: id, approverMemberId: 1, via: "chat", siteUrl: "http://x", send: async () => true });
    expect(viaChat).toMatchObject({ ok: false, reason: "no_vouch" });
    const tapped = await approveInChat(db, { applicationId: id, siteUrl: "http://x", send: async () => true, tapper: { telegramId: 77, username: "sam", memberId: null } });
    expect(tapped).toMatchObject({ ok: false, reason: "no_vouch" });
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
    expect((await res.json()).reason).toBe("not_coop"); // on the site a co-op member vouches
    const [row] = await db.sql(`select vouched_by from applications where id = $1`, [id]);
    expect(row.vouched_by).toBeNull();
    // The applicant's own member row (if they had one in standing) still can't vouch for them.
    await db.sql(`insert into members(name, email, member_type, is_coop_member, supabase_user_id) values ('Pat', 'pat@x.test', 'hub_friend', true, $1)`, [uid(5)]);
    as(5, "pat@x.test");
    const self = await vouchRoute(new Request("http://x", { method: "POST" }), params(id));
    expect((await self.json()).reason).toBe("own_application");
  });

  it("the named co-op member vouches from the portal, the card turns to Approve, and a co-op member approves: one member, one email, audited", async () => {
    const id = await apply(3);
    as(3, "carey@hub.test");
    const v = await vouchRoute(new Request("http://x", { method: "POST" }), params(id));
    expect(v.status).toBe(200);
    const edit = chat.find((c) => c.method === "editMessageText")!.body;
    expect(edit.message_id).toBe(500);
    expect(String(edit.text)).toContain("Vouched for by Carey Member");
    expect(JSON.stringify(edit.reply_markup)).toContain(`app_approve_${id}`);

    expect(String(edit.text)).toContain("Anyone here can approve.");

    // On the site, a site admin who isn't a co-op member can't approve (route and SQL both refuse).
    expect((await approveApplication(db, { applicationId: id, approverMemberId: 2, via: "site", siteUrl: "http://x", send: async () => true }))
      ).toMatchObject({ ok: false, reason: "not_allowed" });
    as(2, "bo@hub.test");
    const refused = await approveRoute(new Request("http://x", { method: "POST" }), params(id));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toMatch(/Co-op members approve/);

    // Carey is a co-op member, not a site admin: she approves.
    as(3, "carey@hub.test");
    const res = await approveRoute(new Request("http://x", { method: "POST" }), params(id));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ approved: true, email_sent: true, email_to: "pat@x.test" });
    const [m] = await db.sql(`select * from members where email = 'pat@x.test'`);
    expect(approvalOf(m)).toMatchObject({ member: true, desk: false, memberBy: 3 });
    expect(m.approved_for_daily).toBe(true); // the old flag follows for one release (072's mirror)
    const audit = await db.sql(`select action, payload from admin_actions where action in ('application_vouched','membership_approved') order by id`);
    expect(audit.map((a) => a.action)).toEqual(["application_vouched", "membership_approved"]);
    expect(audit[1].payload).toMatchObject({ application_id: id, vouched_by: 3, via: "site" });
    expect(stagingOutboxMails().filter((x) => x.subject.includes("pick your plan"))).toHaveLength(1);
    // Approving again changes nothing and sends nothing.
    await approveRoute(new Request("http://x", { method: "POST" }), params(id));
    expect(stagingOutboxMails().filter((x) => x.subject.includes("pick your plan"))).toHaveLength(1);
  });

  it("an approved application can't be moved by hand; taking the approval back closes it so they can apply again", async () => {
    const id = await apply(3);
    as(3, "carey@hub.test");
    await vouchRoute(new Request("http://x", { method: "POST" }), params(id));
    await approveRoute(new Request("http://x", { method: "POST" }), params(id));
    for (const status of ["pending", "rejected", "closed"]) {
      const res = await statusRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ id, status }) }));
      expect(res.status, status).toBe(409);
    }
    expect((await statusRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ id: 9999, status: "closed" }) }))).status).toBe(404);
    const [pat] = await db.sql<{ id: number }>(`select id from members where email = 'pat@x.test'`);
    as(2, "bo@hub.test");
    const back = await switchRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ level: "member", approved: false }) }), params(pat.id));
    expect(back.status).toBe(200);
    expect((await db.sql(`select status from applications where id = $1`, [id]))[0].status).toBe("closed");
    await apply(3);
    expect((await db.sql(`select status, vouched_by from applications where id = $1`, [id]))[0]).toEqual({ status: "pending", vouched_by: null });
  });

  it("the bot and the admin page approve through the same function", async () => {
    const bot = await readFile(new URL("../../bot/src/bot.ts", import.meta.url), "utf8");
    const web = await readFile(new URL("../src/app/api/admin/applications/[id]/approve/route.ts", import.meta.url), "utf8");
    const sql = await readFile(new URL("../../../supabase/migrations/074_who_approves.sql", import.meta.url), "utf8");
    // The bot hands every card tap to @regenhub/shared; the site calls approveApplication; both land in one SQL body.
    expect(bot).toMatch(/import \{[^}]*\bhandleApprovalTap\b[^}]*\} from "@regenhub\/shared"/);
    expect(web).toMatch(/await approveApplication\(/);
    expect(sql).toMatch(/function approve_application\([^)]*\)[\s\S]*?approve_application_core\(/);
    expect(sql).toMatch(/function chat_approve_application\([^)]*\)[\s\S]*?approve_application_core\(/);
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
    await approveRoute(new Request("http://x", { method: "POST" }), params(id));
    const [m] = await db.sql<{ id: number }>(`select id from members where email = 'pat@x.test'`);
    return m.id;
  }
  const subscribe = (plan: string) => subscribeRoute(new Request("http://x", json({ plan_key: plan })));

  it("before approval nothing; after it each day plan; a desk only once a co-op member turns access on", async () => {
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

    // Desk access is a co-op member's (Aaron, 11-24): site admins who aren't co-op members are refused, ops admin or
    // not; Eve (co-op, not ops admin) turns it on. Custom desk prices follow the same rule.
    const deskOn = () => switchRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ level: "desk", approved: true }) }), params(patId));
    const deskPrice = () => customPriceRoute(new Request("http://x", json({ plan_key: "hot_desk", monthly_cents: 20000 })), params(patId));
    for (const [n, email] of [[2, "bo@hub.test"], [1, "ana@hub.test"]] as const) {
      as(n, email);
      expect((await deskOn()).status, email).toBe(403);
      expect((await deskPrice()).status, email).toBe(403);
    }
    as(5, "pat@x.test");
    expect((await subscribe("hot_desk")).status).toBe(403); // still no desk
    as(6, "eve@hub.test");
    const on = await deskOn();
    expect(on.status).toBe(200);
    expect((await deskPrice()).status).not.toBe(403);
    const [pat] = await db.sql(`select desk_access, desk_access_by from members where id = $1`, [patId]);
    expect(pat).toEqual({ desk_access: true, desk_access_by: 6 });
    as(5, "pat@x.test");
    expect((await subscribe("hot_desk")).status).toBe(200);
    expect((await subscribe("cold_desk")).status).toBe(200);
  });
});

/** Where a server component redirected to, or null if it rendered. */
async function redirectOf(render: () => Promise<unknown>): Promise<string | null> {
  try { await render(); return null; } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw e;
    return digest.split(";")[2];
  }
}

describe("who approves (migration 074): anyone in the members' chat, co-op members on the site", () => {
  const sent: { kind: string; to: string }[] = [];
  const deps = (memberFor: (from: { id: number }) => Promise<{ id: number } | null> = async () => null) => ({
    memberFor, siteUrl: "http://x", send: async (m: { kind: string; to: string }) => { sent.push(m); return true; },
  });
  const tap = (data: string, from: { id: number; username?: string }, chatId: number | string | null = -100) =>
    handleApprovalTap(db, { data, chatId, messageId: 500, messageText: "card", from: { first_name: "Sam", ...from } }, deps());
  beforeEach(() => { sent.length = 0; });

  it("a tap from the core chat by someone whose Telegram isn't linked vouches and approves, recording their Telegram", async () => {
    const id = await apply(null);
    expect(await tap(`app_vouch_${id}`, { id: 4242, username: "river" })).toEqual({ handled: true });
    const edit = chat.filter((c) => c.method === "editMessageText").at(-1)!.body;
    expect(String(edit.text)).toContain("Vouched for by @river in the chat");
    expect(String(edit.text)).toContain("Anyone here can approve.");

    expect(await tap(`app_approve_${id}`, { id: 5151, username: "sky" })).toEqual({ handled: true });
    const [app] = await db.sql(`select status, vouched_by, vouched_by_telegram_id, vouched_by_telegram, approved_by,
      approved_by_telegram_id, approved_by_telegram from applications where id = $1`, [id]);
    expect(app).toEqual({ status: "approved", vouched_by: null, vouched_by_telegram_id: 4242, vouched_by_telegram: "river",
      approved_by: null, approved_by_telegram_id: 5151, approved_by_telegram: "sky" });
    const [m] = await db.sql(`select * from members where email = 'pat@x.test'`);
    expect(approvalOf(m)).toMatchObject({ member: true, desk: false, memberBy: null });
    const audit = await db.sql(`select action, actor_member_id, payload from admin_actions where action in ('application_vouched','membership_approved') order by id`);
    expect(audit.map((a) => a.action)).toEqual(["application_vouched", "membership_approved"]);
    expect(audit[1]).toMatchObject({ actor_member_id: null, payload: { via: "chat", telegram_id: 5151, telegram_username: "sky", vouched_by_telegram_id: 4242 } });
    expect(sent.map((x) => x.kind)).toEqual(["membership_approved"]);
    expect(String(chat.filter((c) => c.method === "editMessageText").at(-1)!.body.text)).toContain("Approved* by @sky in the chat");
  });

  it("a linked member in the chat is recorded by their member row, admin or not", async () => {
    const id = await apply(null);
    const linked = deps(async (from) => (from.id === 1003 ? { id: 3 } : null));
    await handleApprovalTap(db, { data: `app_vouch_${id}`, chatId: -100, messageId: 500, from: { id: 1003, username: "carey_hub" } }, linked);
    await handleApprovalTap(db, { data: `app_approve_${id}`, chatId: "-100", messageId: 500, from: { id: 1003, username: "carey_hub" } }, linked);
    const [app] = await db.sql(`select status, vouched_by, approved_by, approved_by_telegram_id from applications where id = $1`, [id]);
    expect(app).toEqual({ status: "approved", vouched_by: 3, approved_by: 3, approved_by_telegram_id: 1003 });
  });

  it("a tap from another chat or a DM is refused and changes nothing", async () => {
    const id = await apply(null);
    for (const where of [-999, 4242, null]) {
      const out = await tap(`app_vouch_${id}`, { id: 4242, username: "river" }, where);
      expect(out, String(where)).toEqual({ handled: true, reply: "Approving and vouching happen in the members' chat." });
    }
    await db.sql(`update applications set vouched_by = 3, vouched_at = now() where id = $1`, [id]);
    expect((await tap(`app_approve_${id}`, { id: 4242 }, 4242)).reply).toMatch(/members' chat/);
    const [{ claim }] = await db.sql<{ claim: number }>(`insert into free_day_claims(email, name, status) values ('g@x.test','G','pending') returning id as claim`);
    expect((await tap(`freeday_approve_${claim}`, { id: 4242 }, -999)).reply).toMatch(/members' chat/);
    expect((await db.sql(`select status from applications where id = $1`, [id]))[0].status).toBe("pending");
    expect((await db.sql(`select status from free_day_claims where id = $1`, [claim]))[0].status).toBe("pending");
    expect(await tap("reveal_pin_3", { id: 1 })).toEqual({ handled: false }); // not ours: the bot carries on
  });

  it("still one vouch before approval, and never your own application (by your member row or your Telegram handle)", async () => {
    as(5, "pat@x.test");
    await applyRoute(new Request("http://x", json({ name: "Pat Newcomer", about: "x", telegram: "@pat_new" })));
    const [{ id }] = await db.sql<{ id: number }>(`select id from applications where email = 'pat@x.test'`);
    expect((await tap(`app_approve_${id}`, { id: 77, username: "sky" })).reply).toBe("A member needs to vouch for them first.");
    expect((await tap(`app_vouch_${id}`, { id: 78, username: "Pat_New" })).reply).toBe("You can't vouch for yourself.");
    await tap(`app_vouch_${id}`, { id: 79, username: "river" });
    expect((await tap(`app_approve_${id}`, { id: 78, username: "pat_new" })).reply).toBe("You can't vouch for yourself.");
    expect((await db.sql(`select status from applications where id = $1`, [id]))[0].status).toBe("pending");
    // A disabled member row can't act from the chat either.
    await db.sql(`update members set disabled = true where id = 3`);
    const out = await handleApprovalTap(db, { data: `app_approve_${id}`, chatId: -100, messageId: 1, from: { id: 1003 } }, deps(async () => ({ id: 3 })));
    expect(out.reply).toBe("This account can't approve: it's switched off on the site.");
    // The applicant's own member row is bound to a Telegram id: that id can't vouch for them, handle or none.
    await db.sql(`insert into members(name, email, member_type, telegram_user_id) values ('Pat', 'pat@x.test', 'day_pass', 8080)`);
    await db.sql(`update applications set vouched_by = null, vouched_at = null, vouched_by_telegram_id = null, vouched_by_telegram = null where id = $1`, [id]);
    expect((await tap(`app_vouch_${id}`, { id: 8080 })).reply).toBe("You can't vouch for yourself.");
  });

  it("free days: anyone in the chat (Telegram recorded), a co-op member on the site, not a site admin who isn't one", async () => {
    const claim = async (email: string) => (await db.sql<{ id: number }>(
      `insert into free_day_claims(email, name, status) values ($1, 'Guest', 'pending') returning id`, [email]))[0].id;
    const a = await claim("a@x.test");
    expect(await tap(`freeday_approve_${a}`, { id: 6060, username: "sky" })).toEqual({ handled: true });
    const [ra] = await db.sql(`select status, approved_by, approved_by_member_id, approved_by_telegram_id from free_day_claims where id = $1`, [a]);
    expect(ra).toEqual({ status: "reserved", approved_by: "@sky", approved_by_member_id: null, approved_by_telegram_id: 6060 });
    expect(sent.map((x) => [x.kind, x.to])).toEqual([["free_day_approved", "a@x.test"]]);
    expect((await tap(`freeday_approve_${a}`, { id: 6061 })).reply).toBe("Already approved."); // one email only
    expect(sent).toHaveLength(1);

    const b = await claim("b@x.test");
    const patch = () => claimsRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ id: b, status: "reserved" }) }));
    as(2, "bo@hub.test");
    expect((await patch()).status).toBe(403);
    as(3, "carey@hub.test");
    expect((await patch()).status).toBe(200);
    const [rb] = await db.sql(`select status, approved_by, approved_by_member_id from free_day_claims where id = $1`, [b]);
    expect(rb).toEqual({ status: "reserved", approved_by: "Carey Member", approved_by_member_id: 3 });
    const audit = await db.sql(`select actor_member_id, payload from admin_actions where action = 'free_day_approved' order by id`);
    expect(audit).toEqual([
      { actor_member_id: null, payload: { via: "chat", telegram_id: 6060, telegram_username: "sky" } },
      { actor_member_id: 3, payload: { via: "site" } },
    ]);
  });

  it("a co-op member who isn't a site admin reaches People to approve; a non-co-op admin sees the lists, not the buttons", async () => {
    const id = await apply(3);
    await db.sql(`update applications set vouched_by = 3, vouched_at = now() where id = $1`, [id]);
    await db.sql(`insert into free_day_claims(email, name, status) values ('g@x.test','Gil Guest','pending')`);
    const html = async (tab?: string) => renderToStaticMarkup(await PeoplePage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));

    as(3, "carey@hub.test");
    expect((await portalViewer()).canApprove).toBe(true);
    const page = await html();
    expect(page).toContain("Pat Newcomer");
    expect(page).toContain("Approve");
    expect(page).not.toContain("Co-op members approve");
    expect(page).not.toContain("Interests"); // only the two tabs with something to approve
    expect(await html("freedays")).toContain("Gil Guest");
    expect(await html("interests")).toContain("Pat Newcomer"); // Interests isn't theirs: Applications instead

    as(2, "bo@hub.test");
    const admin = await html();
    expect(admin).toContain("Pat Newcomer");
    expect(admin).toContain("Co-op members approve");
    expect(admin).toContain("Interests");

    as(4, "dan@x.test");
    expect(await redirectOf(() => html())).toBe("/portal");
  });

  it("before 074 runs: a linked member approves through 072's rule; an unlinked tapper is told to link first", async () => {
    const old = await makePgDb({ before: "074" });
    try {
      await old.sql(`insert into members(id, name, email, member_type, is_admin) values (1, 'Ana', 'ana@hub.test', 'hot_desk', true)`);
      await old.sql(`insert into applications(id, email, name, status, vouched_by, vouched_at) values (9, 'p@x.test', 'P', 'pending', 1, now())`);
      const call = (from: { id: number }, member: { id: number } | null) => handleApprovalTap(old,
        { data: "app_approve_9", chatId: -100, messageId: 1, from }, { ...deps(async () => member) });
      expect((await call({ id: 5 }, null)).reply).toMatch(/Link your Telegram/);
      await old.sql(`insert into members(id, name, email, member_type) values (2, 'Bea', 'bea@hub.test', 'hub_friend')`);
      await old.sql(`select setval('members_id_seq', 100)`);
      expect((await call({ id: 8 }, { id: 2 })).reply).toBe("Until migration 074 runs, only a site admin (with their Telegram linked, account on) approves from the chat; then anyone here can.");
      expect(await call({ id: 6 }, { id: 1 })).toEqual({ handled: true });
      expect((await old.sql(`select status, approved_by from applications where id = 9`))[0]).toEqual({ status: "approved", approved_by: 1 });
      await old.sql(`insert into free_day_claims(id, email, name, status) values (4, 'f@x.test', 'F', 'pending')`);
      await handleApprovalTap(old, { data: "freeday_approve_4", chatId: -100, messageId: 1, from: { id: 7, username: "sky" } }, deps());
      expect((await old.sql(`select status, approved_by from free_day_claims where id = 4`))[0]).toEqual({ status: "reserved", approved_by: "@sky" });
    } finally {
      await old.close();
    }
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

describe("a free day the rule approved still gets its first-visit hello", () => {
  it("names the night they came to, though their member row came after the night's note", async () => {
    await db.sql(`insert into night_followup_batches(id, event_uri, event_name, decision, decided_by_did) values (1, 'at://e/1', 'Civic Tech Night', 'send', 'did:plc:x')`);
    await db.sql(`insert into night_followups(batch_id, event_uri, email, variant, status) values (1, 'at://e/1', 'night@x.test', 'guest', 'sent')`);
    const res = await claimRoute(new Request("http://x", json({ name: "Nia Night", email: "night@x.test", about: "Things", why_join: "Curious" })));
    expect(res.status).toBe(200);
    const [m] = await db.sql<{ id: number }>(`select id from members where email = 'night@x.test'`);
    expect(m).toBeTruthy(); // the approval trigger made the member row
    const [log] = await db.sql<{ id: number; created_at: string }>(
      `insert into access_logs(member_id, method, result, created_at) values ($1, 'pin', 'granted', now()) returning id, created_at`, [m.id]);
    chat = [];
    const outcome = await welcomeFirstVisit(db as never, { id: log.id, member_id: m.id, slot: null, result: "granted", created_at: log.created_at });
    expect(outcome).toMatchObject({ posted: true });
    expect(chat.map((c) => String(c.body.text)).join("\n")).toContain("Civic Tech Night");
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
    // "Dan Daypass" matches too, but isn't a member; Ana isn't listed in the directory, so first name and initial.
    expect(found.members).toEqual([{ id: 1, name: "Ana A." }]);
    await db.sql(`update members set show_in_directory = true where id = 1`);
    expect((await (await searchRoute(new Request("http://x/api/portal/members/search?q=an"))).json()).members).toEqual([{ id: 1, name: "Ana Admin" }]);
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
