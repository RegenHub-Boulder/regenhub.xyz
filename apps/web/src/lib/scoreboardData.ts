/**
 * Reads what /admin/scoreboard shows. Server only (service client, after the staff gate). Every count is done by
 * the pure functions in lib/scoreboard.ts; this file only fetches rows. Nothing here is written or sent anywhere.
 */
import type { createServiceClient } from "@/lib/supabase/admin";
import { compileAudience } from "@/lib/newsletter";
import { issueProgress } from "@/lib/newsletterSend";
import { fetchAttendance, fetchCollectiveEvents } from "@/lib/regenos/events";
import { membershipInvoices } from "@/lib/onchain/invoiceKind";
import { dateIn } from "@/lib/series";
import {
  SCOREBOARD_GOALS, SCOREBOARD_TZ, canceledSince, dayPassPool, funnelByMonth, goalProgress, headlineText, lastMonths,
  lastVisits, passBuyersNeverSubscribed, subscriptionFlow, turnoutBySeries,
  type MemberRow, type PurchaseRow, type SubRow, type TurnoutEvent,
} from "@/lib/scoreboard";

type Admin = ReturnType<typeof createServiceClient>;

const PAGE = 1000;
const TURNOUT_PAST_DAYS = 60;

/** Every row a query matches, a page at a time, so PostgREST's row cap can't shorten a count. */
async function readAll<T>(label: string, page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Each listed person's latest granted door visit: one row per member, not their whole history. */
async function lastVisitOf(admin: Admin, memberIds: number[]): Promise<Map<number, string>> {
  const rows = await mapLimit(memberIds, 8, async (id) => {
    const { data, error } = await admin.from("access_logs").select("member_id, created_at").eq("result", "granted")
      .eq("member_id", id).order("created_at", { ascending: false }).limit(1);
    if (error) throw new Error(`access_logs: ${error.message}`);
    return (data ?? []) as { member_id: number | null; created_at: string }[];
  });
  return lastVisits(rows.flat());
}

/** USDC subscriptions with a paid membership invoice: the ones that started. */
async function paidOnchainSubscriptions(admin: Admin): Promise<Set<number>> {
  const rows = await readAll<{ subscription_id: number }>("onchain_invoices", (from, to) =>
    membershipInvoices((kindColumn) => {
      const q = admin.from("onchain_invoices").select("subscription_id").eq("status", "paid");
      return (kindColumn ? q.eq("kind", "membership") : q).order("id", { ascending: true }).range(from, to);
    }));
  return new Set(rows.map((r) => r.subscription_id));
}

async function newsletterNumbers(admin: Admin) {
  try {
    const [audience, { data: issue, error }] = await Promise.all([
      compileAudience(admin),
      admin.from("newsletter_issues").select("id, subject, issue_key, status, created_at")
        .in("status", ["sent", "sending"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (error) throw error;
    const last = issue as { id: number; subject: string; issue_key: string; status: string; created_at: string } | null;
    const progress = last ? await issueProgress(admin, last.id) : null;
    return {
      listSize: audience.length,
      lastIssue: last && progress
        ? { subject: last.subject, issueKey: last.issue_key, status: last.status, createdAt: last.created_at, sent: progress.sent, failed: progress.failed, pending: progress.pending, total: progress.total }
        : null,
    };
  } catch (e) {
    console.error("[scoreboard] newsletter read failed", e);
    return { listSize: null, lastIssue: null };
  }
}

/** The collective's events from 60 days back on, each with its going count (the same read /admin/events does). */
async function turnout(now: Date): Promise<TurnoutEvent[] | null> {
  const events = await fetchCollectiveEvents({ after: new Date(now.getTime() - TURNOUT_PAST_DAYS * 86_400_000).toISOString() });
  if (!events) return null;
  // The same per-event read /admin/events does; a few at a time so a long calendar doesn't fan out at once.
  const going = await mapLimit(events, 6, (e) => fetchAttendance(e.uri).then((a) => a?.going ?? null));
  return events.map((e, i) => ({
    uri: e.uri, name: e.name, startAt: e.startAt, url: e.url, seriesName: e.series?.name ?? null, going: going[i],
  }));
}

export async function readScoreboard(admin: Admin, now = new Date()) {
  const months = lastMonths(now);
  // A day before the first month in UTC, so no Denver-local row of that month is cut; months outside are ignored.
  const since = new Date(Date.parse(`${months[0]}-01T00:00:00Z`) - 86_400_000).toISOString();

  const [rawSubs, paidOnchain, members, interests, applications, purchases, newsletter, events] = await Promise.all([
    readAll<SubRow>("subscriptions", (f, t) => admin.from("subscriptions")
      .select("id, member_id, plan_key, status, monthly_cents, net_cents, payment_rail, created_at, canceled_at, updated_at, " +
        "cancel_at_period_end, admin_canceled_at, admin_cancel_mode")
      .order("id", { ascending: true }).range(f, t)),
    paidOnchainSubscriptions(admin),
    readAll<MemberRow>("members", (f, t) => admin.from("members").select("id, name, email, member_type, disabled")
      .order("id", { ascending: true }).range(f, t)),
    readAll<{ created_at: string }>("interests", (f, t) => admin.from("interests").select("created_at")
      .gte("created_at", since).order("id", { ascending: true }).range(f, t)),
    readAll<{ created_at: string }>("applications", (f, t) => admin.from("applications").select("created_at")
      .gte("created_at", since).order("id", { ascending: true }).range(f, t)),
    readAll<PurchaseRow>("purchases", (f, t) => admin.from("purchases").select("member_id, email, created_at")
      .order("id", { ascending: true }).range(f, t)),
    newsletterNumbers(admin),
    turnout(now).catch((e) => {
      console.error("[scoreboard] events read failed", e);
      return null;
    }),
  ]);

  const subs: SubRow[] = rawSubs.map((s) => (s.payment_rail === "onchain" ? { ...s, paid: paidOnchain.has(s.id) } : s));

  // Last visits only for the people on the two follow-up lists: find who is on them, then read their visits.
  const followUpSince = SCOREBOARD_GOALS.followUpSince;
  const onLists = new Set<number>([
    ...canceledSince(subs, members, new Map(), followUpSince).map((c) => c.memberId),
    ...passBuyersNeverSubscribed(purchases, subs, members, new Map()).flatMap((b) => (b.memberId != null ? [b.memberId] : [])),
  ]);
  const visits = await lastVisitOf(admin, [...onLists]);
  const canceled = canceledSince(subs, members, visits, followUpSince);
  const passBuyers = passBuyersNeverSubscribed(purchases, subs, members, visits);

  const goal = goalProgress(subs);
  const flow = subscriptionFlow(subs, months);
  const funnel = funnelByMonth({ interests, applications, purchases, subs }, months);
  const pool = dayPassPool(members, subs);
  const today = dateIn(now.toISOString(), SCOREBOARD_TZ);
  return {
    today,
    months,
    goal,
    flow,
    funnel,
    pool,
    canceled,
    passBuyers,
    turnout: events ? turnoutBySeries(events, now, TURNOUT_PAST_DAYS) : null,
    newsletter,
    text: headlineText({ today, goal, flow, funnel, pool, newsletter }),
  };
}

export type Scoreboard = Awaited<ReturnType<typeof readScoreboard>>;
