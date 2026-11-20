/**
 * Reads what /admin/scoreboard shows. Server only (service client, after the staff gate). Every count is done by
 * the pure functions in lib/scoreboard.ts; this file only fetches rows. Nothing here is written or sent anywhere.
 */
import type { createServiceClient } from "@/lib/supabase/admin";
import { compileAudience } from "@/lib/newsletter";
import { issueProgress } from "@/lib/newsletterSend";
import { fetchAttendance, fetchCollectiveEvents } from "@/lib/regenos/events";
import { dateIn } from "@/lib/series";
import {
  SCOREBOARD_GOALS, SCOREBOARD_TZ, canceledSince, dayPassPool, funnelByMonth, goalProgress, headlineText, lastMonths,
  lastVisits, passBuyersNeverSubscribed, subscriptionFlow, turnoutBySeries,
  type MemberRow, type PurchaseRow, type SubRow, type TurnoutEvent, type VisitRow,
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

/** Visits of the given members only (the follow-up lists), in chunks so the URL stays short. */
async function visitsOf(admin: Admin, memberIds: number[]): Promise<VisitRow[]> {
  const out: VisitRow[] = [];
  for (let i = 0; i < memberIds.length; i += 200) {
    const ids = memberIds.slice(i, i + 200);
    out.push(...await readAll<VisitRow>("access_logs", (from, to) =>
      admin.from("access_logs").select("member_id, created_at").eq("result", "granted").in("member_id", ids)
        .order("id", { ascending: true }).range(from, to)));
  }
  return out;
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
  const going = await Promise.all(events.map((e) => fetchAttendance(e.uri).then((a) => a?.going ?? null)));
  return events.map((e, i) => ({
    uri: e.uri, name: e.name, startAt: e.startAt, url: e.url, seriesName: e.series?.name ?? null, going: going[i],
  }));
}

export async function readScoreboard(admin: Admin, now = new Date()) {
  const months = lastMonths(now);
  // A day before the first month in UTC, so no Denver-local row of that month is cut; months outside are ignored.
  const since = new Date(Date.parse(`${months[0]}-01T00:00:00Z`) - 86_400_000).toISOString();

  const [subs, members, interests, applications, purchases, newsletter, events] = await Promise.all([
    readAll<SubRow>("subscriptions", (f, t) => admin.from("subscriptions")
      .select("id, member_id, plan_key, status, monthly_cents, net_cents, payment_rail, created_at, canceled_at, updated_at")
      .order("id", { ascending: true }).range(f, t)),
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

  // Last visits only for the people on the follow-up lists.
  const followIds = new Set<number>();
  for (const s of subs) if (s.status === "canceled") followIds.add(s.member_id);
  const byEmail = new Map(members.filter((m) => m.email).map((m) => [m.email!.toLowerCase(), m.id]));
  for (const p of purchases) {
    const id = p.member_id ?? (p.email ? byEmail.get(p.email.toLowerCase()) : undefined);
    if (id != null) followIds.add(id);
  }
  const visits = lastVisits(await visitsOf(admin, [...followIds]));

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
    canceled: canceledSince(subs, members, visits, SCOREBOARD_GOALS.followUpSince),
    passBuyers: passBuyersNeverSubscribed(purchases, subs, members, visits),
    turnout: events ? turnoutBySeries(events, now, TURNOUT_PAST_DAYS) : null,
    newsletter,
    text: headlineText({ today, goal, flow, funnel, pool, newsletter }),
  };
}

export type Scoreboard = Awaited<ReturnType<typeof readScoreboard>>;
