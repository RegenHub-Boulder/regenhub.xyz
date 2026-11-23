import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "../../../test/pgDb";
import { makeSupabaseMock } from "../../../test/mockSupabase";

// The MCP scoreboard tools against a real Postgres with every migration applied (test/pgDb.ts): readScoreboard,
// the rules and the Done/Not now marks are the real code. Faked: Techne (events, RSVPs, handle lookups; network),
// and the signed-in session for the mark route.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/regenos/events", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/regenos/events")>(),
  fetchCollectiveEvents: vi.fn(),
  fetchAttendance: vi.fn(),
}));
vi.mock("@/lib/techne/did", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/techne/did")>(),
  handleFor: vi.fn(async () => "riley.techne.test"),
}));

import { createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { fetchAttendance, fetchCollectiveEvents } from "@/lib/regenos/events";
import { readScoreboard } from "@/lib/scoreboardData";
import { POST as markAction } from "@/app/api/admin/scoreboard/actions/route";
import { GET as downloadCsv } from "@/app/api/admin/scoreboard/months/route";
import type { McpAuthInfo } from "./oauth";
import { recommendedActionsHandler, scoreboardSummaryHandler } from "./scoreboardTools";
import type { ToolResult } from "./billingTools";

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const body = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const EMAIL = /[^\s@(]+@[^\s@]+\.[a-z]{2,}/i;

let db: PgDb;
const ALL = ["read", "deploy", "locks", "migrate", "billing"];
const ada = (scopes = ALL): McpAuthInfo => ({ token: "t", clientId: "c", scopes, extra: { memberId: 1, email: "ada@example.test", isAdmin: true, isOpsAdmin: true } });

async function seed() {
  await db.exec(`
    insert into members (id, name, email, is_admin, is_ops_admin, member_type) values (1, 'Ada Admin', 'ada@example.test', true, true, 'hot_desk');
    insert into members (id, name, email, member_type, did) values
      (7, 'Pat Example', 'pat@example.test', 'hot_desk', null),
      (8, 'Brent Porter', 'brent@example.test', 'day_pass', null),
      (9, 'Cleo Card', 'cleo@example.test', 'day_pass', null),
      (10, 'Gil Guest', 'gil@example.test', 'day_pass', 'did:plc:gil');`);
  // Pat: past due on a card hot desk. Brent: left 20 days ago. Cleo: joined 5 days ago.
  await db.sql(`insert into subscriptions (id, member_id, payment_rail, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_key, monthly_cents, net_cents, status, past_due_since, created_at)
    values (60, 7, 'stripe', 'sub_pat', 'cus_pat', 'price_hd', 'hot_desk', 25000, 25000, 'past_due', $1, $2)`, [iso(-4 * DAY), iso(-200 * DAY)]);
  await db.sql(`insert into subscriptions (id, member_id, payment_rail, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_key, monthly_cents, net_cents, status, canceled_at, created_at)
    values (61, 8, 'stripe', 'sub_brent', 'cus_brent', 'price_2d', 'member_2day', 5000, 5000, 'canceled', $1, $2)`, [iso(-20 * DAY), iso(-300 * DAY)]);
  await db.sql(`insert into subscriptions (id, member_id, payment_rail, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_key, monthly_cents, net_cents, status, created_at)
    values (62, 9, 'stripe', 'sub_cleo', 'cus_cleo', 'price_b', 'member_basic', 3000, 3000, 'active', $1)`, [iso(-5 * DAY)]);
  // Two nights of a series in the last month: Gil (a member row, no membership) and an unlinked account at both.
  vi.mocked(fetchCollectiveEvents).mockResolvedValue([
    { uri: "at://c/e/1", name: "Agents Night", startAt: iso(-21 * DAY), url: "/events/c/1", series: { name: "Agents Night" } },
    { uri: "at://c/e/2", name: "Agents Night", startAt: iso(-7 * DAY), url: "/events/c/2", series: { name: "Agents Night" } },
  ] as never);
  vi.mocked(fetchAttendance).mockImplementation(async () => ({ going: 2, goingDids: ["did:plc:gil", "did:plc:riley"], goingRsvps: [{ did: "did:plc:gil", at: "" }, { did: "did:plc:riley", at: "" }] }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = await makePgDb();
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  await seed();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

describe("auth", () => {
  it("both tools refuse a token without the read scope, before reading anything", async () => {
    for (const r of [await scoreboardSummaryHandler(db as never, ada(["deploy"])), await recommendedActionsHandler(db as never, ada(["deploy"]), {})]) {
      expect(r.isError).toBe(true);
      expect(body(r)).toMatch(/requires the "read" scope/);
    }
    expect(fetchCollectiveEvents).not.toHaveBeenCalled();
  });
});

describe("scoreboard_summary", () => {
  it("gives headline numbers, pace, months, funnel and turnout, with no names or contact details", async () => {
    const r = await scoreboardSummaryHandler(db as never, ada());
    expect(r.isError, body(r)).toBeFalsy();
    const t = body(r);
    expect(t).toMatch(/Paying members \(\$30\+\/mo\): 1 /); // Cleo; Pat is past due
    expect(t).toMatch(/1 more past due/);
    expect(t).toMatch(/### Goal pace/);
    expect(t).toMatch(/### Month by month/);
    expect(t).toMatch(/\| all plans \| 1 \| \$30 \| 0 \| 1 \|/); // by plan now: Cleo paying, Pat past due
    expect(t).toMatch(/\*\*Agents Night\*\* — 4 going over 2 past/);
    expect(t).toMatch(/Open recommended actions: 7 /);
    expect(t).not.toMatch(EMAIL);
    for (const name of ["Pat", "Brent", "Cleo", "Gil", "cus_", "sub_", "price_"]) expect(t).not.toContain(name);
  });
});

describe("scoreboard_summary who_is_coming", () => {
  it("lists who is going to each upcoming night by name and handle, members first, never an email", async () => {
    vi.mocked(fetchCollectiveEvents).mockResolvedValue([
      { uri: "at://c/e/1", name: "Agents Night", startAt: iso(-21 * DAY), url: "/events/c/1", series: { name: "Agents Night" } },
      { uri: "at://c/e/3", name: "Agents Night", startAt: iso(3 * DAY), url: "/events/c/3", series: { name: "Agents Night" } },
    ] as never);
    const t = body(await scoreboardSummaryHandler(db as never, ada(), { who_is_coming: true }));
    expect(t).toMatch(/### Who's coming/);
    // Gil: a member row with no plan; the other account: a guest, by the handle Techne resolves.
    expect(t).toMatch(/\*\*\d{4}-\d{2}-\d{2} Agents Night\*\*\n- Gil Guest \(@riley\.techne\.test\) — member, no current plan\n- @riley\.techne\.test — guest/);
    expect(t).not.toMatch(EMAIL);
    // Without the flag: no names, as before.
    expect(body(await scoreboardSummaryHandler(db as never, ada()))).not.toContain("Gil");
  });
});

/** The CSV in a summary (or the download): header → value per month. Data cells hold no commas. */
function csvRows(csv: string): Record<string, string>[] {
  const [head, ...lines] = csv.trim().split(/\r?\n/);
  const keys = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v])));
}
const sum = (rows: Record<string, string>[], key: string) => rows.reduce((n, r) => n + Number(r[key] || 0), 0);

describe("the month table, on the real schema", () => {
  beforeEach(async () => {
    // Door: Cleo twice on one day on her own code, a guest's day code, an unlock nobody can be named for, a denied try.
    await db.sql(`insert into access_logs (member_id, method, slot, result, created_at) values
      (9, 'pin', 5, 'granted', $1), (9, 'pin', 5, 'granted', $1), (9, 'pin', 120, 'granted', $1),
      (null, 'pin', null, 'granted', $1), (8, 'pin', 6, 'denied', $1)`, [iso(-3600_000)]);
    // Brent's card pass; a USDC pass needs an on-chain invoice row, so it's covered in the unit tests.
    await db.sql(`insert into purchases (member_id, kind, amount_cents, passes_granted, created_at) values (8, 'day_pass', 3000, 1, $1)`, [iso(-3600_000)]);
    await db.sql(`insert into interests (email, source_path, created_at) values ('reader@example.test', '/', $1), ('READER@example.test', 'luma', $1)`, [iso(-3600_000)]);
    // Cleo's $30 plan moved up to a hot desk in place (Stripe keeps one row; the audit log keeps the change).
    await db.sql(`insert into admin_actions (action, target_table, target_id, payload, created_at)
      values ('card_plan_changed', 'subscriptions', '62', '{"subscription_id": 62, "from": "member_basic", "to": "hot_desk"}', $1)`, [iso(-3600_000)]);
  });

  it("scoreboard_summary carries it as CSV, the download gives the same, and neither has a name or an email", async () => {
    const t = body(await scoreboardSummaryHandler(db as never, ada()));
    const csv = t.split("```csv\n")[1].split("\n```")[0];
    const rows = csvRows(csv);
    expect(rows[0]["Month (America/Denver)"]).toBe("2026-07");
    expect(rows.at(-1)!["Month complete (no = so far)"]).toBe("no");
    expect(sum(rows, "Member days at the space (member x day with a door entry)")).toBe(1);
    expect(sum(rows, "Day-code days at the space (day code x day with a door entry)")).toBe(1);
    expect(sum(rows, "Added to the list this month (emails)")).toBe(1); // one person, two rows
    expect(sum(rows, "Single day passes bought by card")).toBe(1);
    expect(rows.at(-1)!["Paying members at month end ($30+/mo plans; the headline count)"]).toBe("1");
    expect(rows.at(-1)!["Net membership revenue at month end (USD per month)"]).toBe("30.00");
    expect(sum(rows, "Day plan to desk: base (people)")).toBe(1);
    expect(sum(rows, "Day plan to desk: converted (people)")).toBe(1);
    expect(csv).not.toMatch(EMAIL);

    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({
      auth: { user: { id: "u1", email: "ada@example.test" } }, selects: { members: { data: { id: 1, name: "Ada Admin", is_admin: true, disabled: false } } },
    }) as never);
    const res = await downloadCsv();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="regenhub-month-by-month-\d{4}-\d{2}-\d{2}\.csv"/);
    const download = await res.text();
    expect(download.replace(/\r\n/g, "\n").trim()).toBe(csv);
    for (const name of ["Ada", "Pat", "Brent", "Cleo", "Gil"]) expect(download).not.toContain(name);
  });
});

describe("recommended_actions", () => {
  it("lists open actions ranked, by name and member id, never an email or a payment id", async () => {
    const t = body(await recommendedActionsHandler(db as never, ada(), {}));
    expect(t).toMatch(/^## What to do next/);
    // Against the real goals this small co-op is far behind the line, so the two pace actions lead.
    expect(t.match(/^\d+\. .*$/gm)!.map((l) => l.replace(/^\d+\. /, ""))).toEqual([
      "[high] Revenue goal — goal pace", "[high] Members goal — goal pace", "[high] Pat Example (member 7) — past due",
      "[medium] Gil Guest (member 10) — regular guest", "[medium] @riley.techne.test — regular guest",
      "[medium] Brent Porter (member 8) — left recently", "[low] Cleo Card (member 9) — new member",
    ]);
    expect(t).toMatch(/3\. \[high\] Pat Example \(member 7\) — past due\n {3}Why: Hot Desk \(\$250\/mo\) payment failed; past due since .* \(4 days\)\.\n {3}Step: Send the payment reminder\.\n {3}id: past_due:m7/);
    expect(t).toMatch(/Brent Porter \(member 8\) — left recently/);
    expect(t).toMatch(/Cleo Card \(member 9\) — new member/);
    expect(t).toMatch(/Gil Guest \(member 10\) — regular guest/);
    expect(t).toMatch(/@riley\.techne\.test — regular guest/);
    expect(t).not.toMatch(EMAIL);
    for (const id of ["cus_", "sub_", "price_"]) expect(t).not.toContain(id);
  });

  it("Done from the page hides one until its facts change; include_dismissed shows it", async () => {
    const s = await readScoreboard(db as never);
    const brent = s.actions.open.find((a) => a.id === "left_recently:m8")!;
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({
      auth: { user: { id: "u1", email: "ada@example.test" } }, selects: { members: { data: { id: 1, name: "Ada Admin", is_admin: true, disabled: false } } },
    }) as never);
    const res = await markAction(new Request("http://localhost/api/admin/scoreboard/actions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: brent.id, fingerprint: brent.fingerprint, state: "done" }),
    }));
    expect(res.status).toBe(200);
    expect(await db.sql("select actor_member_id, target_id, payload from admin_actions where action = 'scoreboard_action_marked'"))
      .toEqual([{ actor_member_id: 1, target_id: "left_recently:m8", payload: { state: "done", fingerprint: brent.fingerprint } }]);

    const after = body(await recommendedActionsHandler(db as never, ada(), {}));
    expect(after).not.toMatch(/Brent Porter/);
    expect(after).toMatch(/6 open, 1 dismissed/);
    expect(body(await recommendedActionsHandler(db as never, ada(), { include_dismissed: true }))).toMatch(/### Dismissed\n1\. .*Brent Porter \(member 8\) — left recently — done/);

    // The facts change (the row ends on a different day): the note is due again.
    await db.sql("update subscriptions set canceled_at = $1 where id = 61", [iso(-2 * DAY)]);
    expect(body(await recommendedActionsHandler(db as never, ada(), {}))).toMatch(/Brent Porter \(member 8\) — left recently/);
  });

  it("the mark route refuses an id that isn't an action's", async () => {
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({
      auth: { user: { id: "u1", email: "ada@example.test" } }, selects: { members: { data: { id: 1, name: "Ada Admin", is_admin: true, disabled: false } } },
    }) as never);
    const res = await markAction(new Request("http://localhost/x", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "Robert'); drop", fingerprint: "x", state: "done" }),
    }));
    expect(res.status).toBe(400);
  });
});
