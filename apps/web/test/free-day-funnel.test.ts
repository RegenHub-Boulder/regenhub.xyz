/**
 * People → Free days (T-482 round 3): every claim lands in one group with one line on where the person is, from real
 * rows (PGlite with every migration, so the free-day triggers that make a member row run too). Hand-made fixtures:
 * a claim with no date (the normal case now), a legacy dated one, an already-member, someone who came in, bought a
 * pass, joined, and a cancelled one. "Invalid Date" must never render.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makePgDb, type PgDb } from "./pgDb";
import { readFreeDays } from "@/lib/freeDayData";
import { placeClaim, fmtDay, fmtDateOnly, type FreeDayGroup } from "@/lib/freeDayFunnel";
import { FreeDaysList } from "@/components/admin/FreeDaysList";

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

let db: PgDb;
let result: Awaited<ReturnType<typeof readFreeDays>>;

beforeAll(async () => {
  db = await makePgDb();
  // Already members before they claimed: a card $50 member and a hot desk (no subscription row, a hand-given desk).
  await db.sql(`insert into members (name, email, member_type, created_at) values
    ('Mo Member', 'mo@example.test', 'day_pass', $1),
    ('Dana Desk', 'dana@example.test', 'hot_desk', $1),
    ('Ina Inviter', 'ina@example.test', 'hub_friend', $1)`, [ago(200)]);
  await db.sql(`insert into subscriptions (member_id, payment_rail, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_key, monthly_cents, status, created_at)
    values ((select id from members where email = 'mo@example.test'), 'stripe', 'sub_mo', 'cus_mo', 'price_mo', 'member_2day', 5000, 'active', $1)`, [ago(100)]);

  // Claims. Reserved ones make their own day_pass member row through the 016/036 trigger.
  // Approved claims are written as the app does: reserved first (the trigger makes the member row), then moved on.
  const claim = async (id: number, email: string, name: string, status: string, createdDaysAgo: number, extra = "null", activated: string | null = null) => {
    const first = status === "pending" ? "pending" : "reserved";
    await db.sql(`insert into free_day_claims (id, email, name, status, claimed_date, created_at, activated_at, about, why_join)
      values ($1, $2, $3, $4, ${extra}, $5, $6, 'Working on things.', 'Curious.')`, [id, email, name, first, ago(createdDaysAgo), activated]);
    if (status !== first) await db.sql("update free_day_claims set status = $2 where id = $1", [id, status]);
  };
  await claim(10, "nora@example.test", "Nora New", "pending", 1);                                   // to review
  await claim(11, "mo@example.test", "Mo Member", "pending", 2);                                    // to review, already a member
  await claim(12, "pat@example.test", "Pat Waiting", "reserved", 9);                               // not in yet, no date
  await claim(13, "leg@example.test", "Lee Legacy", "reserved", 60, "'2026-09-04'");               // not in yet, legacy date
  await claim(14, "dana@example.test", "Dana Desk", "reserved", 20);                               // already a member
  await claim(15, "cam@example.test", "Cam Came", "activated", 15, "null", ago(14));               // came in (code issued)
  await claim(16, "eve@example.test", "Eve Entry", "reserved", 12);                                // came in (door entry, never activated)
  await claim(17, "bea@example.test", "Bea Bought", "activated", 30, "null", ago(29));             // bought a pass since
  await claim(18, "jo@example.test", "Jo Joined", "activated", 40, "null", ago(39));               // joined since
  await claim(19, "cy@example.test", "Cy Cancelled", "cancelled", 5);                              // closed
  await db.sql("update free_day_claims set invited_by_member_id = (select id from members where email = 'ina@example.test') where id = 12");

  const memberId = async (email: string) => (await db.sql<{ id: number }>("select id from members where email = $1", [email]))[0].id;
  await db.sql("insert into access_logs (member_id, method, result, created_at) values ($1, 'daycode', 'granted', $2)", [await memberId("eve@example.test"), ago(10)]);
  await db.sql("insert into access_logs (member_id, method, result, created_at) values ($1, 'daycode', 'denied', $2)", [await memberId("pat@example.test"), ago(3)]);
  await db.sql("insert into purchases (member_id, kind, amount_cents, passes_granted, created_at) values ($1, 'day_pass', 3000, 1, $2)", [await memberId("bea@example.test"), ago(20)]);
  await db.sql(`insert into subscriptions (member_id, payment_rail, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_key, monthly_cents, status, created_at)
    values ($1, 'stripe', 'sub_jo', 'cus_jo', 'price_jo', 'member_basic', 3000, 'active', $2)`, [await memberId("jo@example.test"), ago(25)]);

  result = await readFreeDays(db as never);
});

const groupOf = (id: number) => result.placed.find((p) => p.claim.id === id)!;

describe("free days, grouped by where the person is", () => {
  it("puts each claim in one group", () => {
    const groups: Record<number, FreeDayGroup> = {
      10: "review", 11: "review", 12: "not_yet", 13: "not_yet", 14: "already_member", 15: "came_in",
      16: "came_in", 17: "joined", 18: "joined", 19: "closed",
    };
    expect(Object.fromEntries(result.placed.map((p) => [p.claim.id, p.group]))).toEqual(groups);
    expect(result.counts).toEqual({ review: 2, not_yet: 2, came_in: 2, joined: 2, already_member: 1, closed: 1 });
  });

  it("says in one line where each one is", () => {
    expect(groupOf(10).line).toMatch(/^Asked \w{3} \d+ · waiting for review$/);
    expect(groupOf(11).line).toMatch(/already a member \(Member \+ 2 days\/mo|already a member \(.+\): no free day needed/);
    expect(groupOf(12).line).toMatch(/with Ina Inviter's invite · approved, hasn't come in yet$/);
    expect(groupOf(14).line).toMatch(/^Already a member \(Hot Desk\) when they claimed/);
    expect(groupOf(15).line).toMatch(/^Came in \w{3} \d+ · no pass or membership yet$/);
    expect(groupOf(16).line).toMatch(/^Came in \w{3} \d+ · no pass or membership yet$/);
    expect(groupOf(17).line).toMatch(/· bought a day pass \w{3} \d+$/);
    expect(groupOf(18).line).toMatch(/· joined .+ \w{3} \d+$/);
    expect(groupOf(19).line).toMatch(/cancelled$/);
  });

  it("shows a legacy date only as 'originally requested for', and a null date not at all", () => {
    expect(groupOf(13).legacy).toBe("originally requested for Fri, Sep 4");
    expect(groupOf(12).legacy).toBeNull();
    const html = FREE_DAY_KEYS.map((show) => renderToStaticMarkup(createElement(FreeDaysList, { ...result, show }))).join("\n");
    expect(html).not.toMatch(/Invalid Date/i);
    expect(html).toContain("originally requested for Fri, Sep 4");
  });

  it("opens on the claims that need action, the same count the admin home shows", () => {
    const html = renderToStaticMarkup(createElement(FreeDaysList, { ...result, show: "review" }));
    expect(html).toContain("Nora New");
    expect(html).toContain("Mo Member");
    expect(html).not.toContain("Pat Waiting");
    expect(html).toContain('aria-current="page"');
    expect((html.match(/data-group="review"/g) ?? []).length).toBe(2);
  });

  it("someone with an older member row who bought a desk after the free day joined; they weren't already a member", () => {
    const placed = placeClaim(
      { id: 2, email: "y@example.test", name: "Y", claimed_date: null, status: "activated", created_at: ago(30), activated_at: ago(29) },
      { member: { member_type: "hot_desk", disabled: false, created_at: ago(300) },
        subscriptions: [{ plan_key: "hot_desk", status: "active", monthly_cents: 25000, created_at: ago(10), canceled_at: null }],
        passBuys: [], entries: [] });
    expect(placed.group).toBe("joined");
    expect(placed.line).toMatch(/joined Hot Desk/);
  });

  it("never formats a missing or broken date", () => {
    expect(fmtDay(null)).toBeNull();
    expect(fmtDay("not a date")).toBeNull();
    expect(fmtDateOnly(null)).toBeNull();
    expect(fmtDateOnly("2026-13-45")).toBeNull();
    const placed = placeClaim({ id: 1, email: "x@example.test", name: "X", claimed_date: null, status: "reserved", created_at: "garbage" },
      { member: null, subscriptions: [], passBuys: [], entries: [] });
    expect(placed.line).not.toMatch(/Invalid/);
  });
});

const FREE_DAY_KEYS: FreeDayGroup[] = ["review", "not_yet", "came_in", "joined", "already_member", "closed"];
