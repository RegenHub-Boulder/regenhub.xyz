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
import { readAll } from "@/lib/supabase/readAll";
import {
  SCOREBOARD_GOALS, SCOREBOARD_TZ, canceledSince, dayPassPool, funnelByMonth, goalProgress, headlineText, lastMonths,
  lastVisits, passBuyersNeverSubscribed, subscriptionFlow, turnoutBySeries,
  type MemberRow, type PurchaseRow, type SubRow, type TurnoutEvent,
} from "@/lib/scoreboard";

type Admin = ReturnType<typeof createServiceClient>;

const TURNOUT_PAST_DAYS = 60;
/** How far back "last visit" looks. */
const VISIT_LOOKBACK_DAYS = 365;

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

/** The listed people's latest granted door visit within the last year: one read per 200 people, bounded in time. */
async function lastVisitOf(admin: Admin, memberIds: number[], now: Date): Promise<Map<number, string>> {
  const since = new Date(now.getTime() - VISIT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const chunks: number[][] = [];
  for (let i = 0; i < memberIds.length; i += 200) chunks.push(memberIds.slice(i, i + 200));
  const rows = await mapLimit(chunks, 4, (ids) =>
    readAll<{ member_id: number | null; created_at: string }>("access_logs", (f, t) =>
      admin.from("access_logs").select("member_id, created_at").eq("result", "granted").in("member_id", ids)
        .gte("created_at", since).order("id", { ascending: true }).range(f, t)));
  return lastVisits(rows.flat());
}

/**
 * Which of these cancelled USDC subscriptions had a membership invoice paid (the ones that started). Only cancelled
 * rows need asking: a USDC row turns active only on a payment, and stays `incomplete` until then.
 */
async function paidOnchain(admin: Admin, subscriptionIds: number[]): Promise<Set<number>> {
  const chunks: number[][] = [];
  for (let i = 0; i < subscriptionIds.length; i += 200) chunks.push(subscriptionIds.slice(i, i + 200));
  const rows = await mapLimit(chunks, 4, (ids) =>
    readAll<{ subscription_id: number }>("onchain_invoices", (from, to) =>
      membershipInvoices((kindColumn) => {
        const q = admin.from("onchain_invoices").select("id, subscription_id").eq("status", "paid").in("subscription_id", ids);
        return (kindColumn ? q.eq("kind", "membership") : q).order("id", { ascending: true }).range(from, to);
      })));
  return new Set(rows.flat().map((r) => r.subscription_id));
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

  const [rawSubs, members, interests, applications, purchases, newsletter, events] = await Promise.all([
    readAll<SubRow>("subscriptions", (f, t) => admin.from("subscriptions")
      .select("id, member_id, plan_key, status, monthly_cents, net_cents, payment_rail, created_at, canceled_at, updated_at, " +
        "cancel_at_period_end, admin_canceled_at, admin_cancel_mode")
      .order("id", { ascending: true }).range(f, t)),
    readAll<MemberRow>("members", (f, t) => admin.from("members").select("id, name, email, member_type, disabled")
      .order("id", { ascending: true }).range(f, t)),
    readAll<{ created_at: string }>("interests", (f, t) => admin.from("interests").select("id, created_at")
      .gte("created_at", since).order("id", { ascending: true }).range(f, t)),
    readAll<{ created_at: string }>("applications", (f, t) => admin.from("applications").select("id, created_at")
      .gte("created_at", since).order("id", { ascending: true }).range(f, t)),
    readAll<PurchaseRow>("purchases", (f, t) => admin.from("purchases").select("id, member_id, email, created_at, passes_granted")
      .order("id", { ascending: true }).range(f, t)),
    newsletterNumbers(admin),
    turnout(now).catch((e) => {
      console.error("[scoreboard] events read failed", e);
      return null;
    }),
  ]);

  const canceledOnchain = rawSubs.filter((s) => s.payment_rail === "onchain" && s.status === "canceled").map((s) => s.id);
  const paid = await paidOnchain(admin, canceledOnchain);
  const subs: SubRow[] = rawSubs.map((s) => (s.payment_rail === "onchain" && s.status === "canceled" ? { ...s, paid: paid.has(s.id) } : s));

  // Last visits only for the people on the two follow-up lists: find who is on them, then read their visits.
  const followUpSince = SCOREBOARD_GOALS.followUpSince;
  const onLists = new Set<number>([
    ...canceledSince(subs, members, new Map(), followUpSince).map((c) => c.memberId),
    ...passBuyersNeverSubscribed(purchases, subs, members, new Map()).flatMap((b) => (b.memberId != null ? [b.memberId] : [])),
  ]);
  const visits = await lastVisitOf(admin, [...onLists], now);
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
