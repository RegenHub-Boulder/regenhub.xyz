/**
 * Reads what /admin/scoreboard shows. Server only (service client, after the staff gate). Every count is done by
 * the pure functions in lib/scoreboard.ts; this file only fetches rows. Nothing here is written or sent anywhere.
 */
import type { createServiceClient } from "@/lib/supabase/admin";
import { compileAudience } from "@/lib/newsletter";
import { issueProgress } from "@/lib/newsletterSend";
import { fetchAttendance, fetchCollectiveEvents } from "@/lib/regenos/events";
import { mapLimit } from "@/lib/mapLimit";
import { membershipInvoices } from "@/lib/onchain/invoiceKind";
import { dateIn } from "@/lib/series";
import { readAll } from "@/lib/supabase/readAll";
import { handleFor } from "@/lib/techne/did";
import { AuditAction } from "@/lib/auditLog";
import {
  SCOREBOARD_GOALS, SCOREBOARD_TZ, canceledSince, dayPassPool, followupFunnel, funnelByMonth, goalPace, goalProgress, headlineText, lastMonths,
  lastVisits, passBuyersNeverSubscribed, subscriptionFlow, turnoutBySeries,
  type MemberRow, type PurchaseRow, type SubRow, type TurnoutEvent,
} from "@/lib/scoreboard";
import {
  ACTION_RULES, frequentGuests, latestStates, recommendedActions, visibleActions, type ActionMark, type ActionState,
} from "@/lib/scoreboardActions";

type Admin = ReturnType<typeof createServiceClient>;

const TURNOUT_PAST_DAYS = 60;
/** How far back "last visit" looks. */
const VISIT_LOOKBACK_DAYS = 365;

/** `fn` over `ids` in chunks of 200 (a short URL), four chunks at a time. */
const inChunks = <R>(ids: number[], fn: (chunk: number[]) => Promise<R[]>): Promise<R[]> => {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
  return mapLimit(chunks, 4, fn).then((r) => r.flat());
};

/** The listed people's latest granted door visit within the last year: one read per 200 people, bounded in time. */
async function lastVisitOf(admin: Admin, memberIds: number[], now: Date): Promise<Map<number, string>> {
  const since = new Date(now.getTime() - VISIT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = await inChunks(memberIds, (ids) =>
    readAll<{ member_id: number | null; created_at: string }>("access_logs", (f, t) =>
      admin.from("access_logs").select("id, member_id, created_at").eq("result", "granted").in("member_id", ids)
        .gte("created_at", since).order("id", { ascending: true }).range(f, t)));
  return lastVisits(rows);
}

/**
 * Which of these cancelled USDC subscriptions had a membership invoice paid (the ones that started). Only cancelled
 * rows need asking: a USDC row turns active only on a payment, and stays `incomplete` until then.
 */
async function paidOnchain(admin: Admin, subscriptionIds: number[]): Promise<Set<number>> {
  const rows = await inChunks(subscriptionIds, (ids) =>
    readAll<{ subscription_id: number }>("onchain_invoices", (from, to) =>
      membershipInvoices((kindColumn) => {
        const q = admin.from("onchain_invoices").select("id, subscription_id").eq("status", "paid").in("subscription_id", ids);
        return (kindColumn ? q.eq("kind", "membership") : q).order("id", { ascending: true }).range(from, to);
      })));
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

/** Guest notes sent after nights (migration 066), from `since`. Null when unreadable (066 not applied yet): the rows
 *  show "—" and nothing else breaks. */
async function followupsSent(admin: Admin, since: string) {
  try {
    return await readAll<{ member_id: number | null; email: string; sent_at: string | null }>("night_followups", (f, t) =>
      admin.from("night_followups").select("id, member_id, email, sent_at").eq("status", "sent").eq("variant", "guest")
        .gte("sent_at", since).order("id", { ascending: true }).range(f, t));
  } catch (e) {
    console.error("[scoreboard] night follow-ups read failed", e);
    return null;
  }
}

/** The collective's events from 60 days back on, each with its going count (the same read /admin/events does). */
async function turnout(now: Date): Promise<TurnoutEvent[] | null> {
  const events = await fetchCollectiveEvents({ after: new Date(now.getTime() - TURNOUT_PAST_DAYS * 86_400_000).toISOString() });
  if (!events) return null;
  // The same per-event read /admin/events does; a few at a time so a long calendar doesn't fan out at once.
  const going = await mapLimit(events, 6, (e) => fetchAttendance(e.uri));
  return events.map((e, i) => ({
    uri: e.uri, name: e.name, startAt: e.startAt, url: e.url, seriesName: e.series?.name ?? null,
    going: going[i]?.going ?? null, goingDids: going[i]?.goingDids ?? [], goingRsvps: going[i]?.goingRsvps ?? [],
  }));
}

/** `admin_actions.action` for a Done / Not now / reopen on a recommended action; target is the action id. */
export const ACTION_MARK = AuditAction.SCOREBOARD_ACTION_MARKED;

/** The marks on recommended actions, latest per action. A failed read shows every action (nothing is hidden). */
export async function readActionStates(admin: Admin): Promise<Map<string, ActionState>> {
  try {
    const rows = await readAll<{ target_id: string; payload: { state?: ActionMark; fingerprint?: string }; created_at: string }>(
      "admin_actions", (f, t) => admin.from("admin_actions").select("id, target_id, payload, created_at")
        .eq("action", ACTION_MARK).order("id", { ascending: true }).range(f, t));
    return latestStates(rows.flatMap((r) => (r.payload?.state && typeof r.payload.fingerprint === "string"
      ? [{ actionId: r.target_id, state: r.payload.state, fingerprint: r.payload.fingerprint, at: r.created_at }]
      : [])));
  } catch (e) {
    console.error("[scoreboard] action marks read failed", e);
    return new Map();
  }
}

export async function readScoreboard(admin: Admin, now = new Date()) {
  const months = lastMonths(now);
  // A day before the first month in UTC, so no Denver-local row of that month is cut; months outside are ignored.
  const since = new Date(Date.parse(`${months[0]}-01T00:00:00Z`) - 86_400_000).toISOString();

  const [rawSubs, members, interests, applications, purchases, newsletter, events, followups] = await Promise.all([
    readAll<SubRow>("subscriptions", (f, t) => admin.from("subscriptions")
      .select("id, member_id, plan_key, status, monthly_cents, net_cents, payment_rail, created_at, canceled_at, updated_at, " +
        "cancel_at_period_end, admin_canceled_at, admin_cancel_mode, past_due_since, current_period_end")
      .order("id", { ascending: true }).range(f, t)),
    readAll<MemberRow>("members", (f, t) => admin.from("members").select("id, name, email, member_type, disabled, did")
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
    followupsSent(admin, since),
  ]);

  const canceledOnchain = rawSubs.filter((s) => s.payment_rail === "onchain" && s.status === "canceled").map((s) => s.id);
  const paid = await paidOnchain(admin, canceledOnchain);
  const subs: SubRow[] = rawSubs.map((s) => (s.payment_rail === "onchain" && s.status === "canceled" ? { ...s, paid: paid.has(s.id) } : s));

  // Last visits only for the people on the follow-up lists and the leavers the actions name: find who, then read.
  const followUpSince = SCOREBOARD_GOALS.followUpSince;
  const leftSince = dateIn(new Date(now.getTime() - ACTION_RULES.leftWithinDays * 86_400_000).toISOString(), SCOREBOARD_TZ);
  const onLists = new Set<number>([
    ...canceledSince(subs, members, new Map(), leftSince < followUpSince ? leftSince : followUpSince).map((c) => c.memberId),
    ...passBuyersNeverSubscribed(purchases, subs, members, new Map()).flatMap((b) => (b.memberId != null ? [b.memberId] : [])),
  ]);
  const visits = await lastVisitOf(admin, [...onLists], now);
  const canceled = canceledSince(subs, members, visits, followUpSince);
  const passBuyers = passBuyersNeverSubscribed(purchases, subs, members, visits);

  const goal = goalProgress(subs);
  const flow = subscriptionFlow(subs, months);
  const funnel = funnelByMonth({ interests, applications, purchases, subs }, months);
  // A note to someone known only by their Techne sign-in (T-497) has no member_id: it counts as the member with that
  // email if they have joined since, so "followed up → joined" sees them.
  const memberByEmail = new Map(members.flatMap((m) => (m.email ? [[m.email.trim().toLowerCase(), m.id] as const] : [])));
  const followUps = followups
    ? followupFunnel(followups.map((f) => (f.member_id == null ? { ...f, member_id: memberByEmail.get(f.email) ?? null } : f)), subs, months)
    : null;
  const pool = dayPassPool(members, subs);
  const today = dateIn(now.toISOString(), SCOREBOARD_TZ);

  // Guests with no member row are named by their verified Techne handle (cached; a failed lookup shows the DID).
  const linked = new Set(members.flatMap((m) => (m.did ? [m.did] : [])));
  const unnamed = [...frequentGuests({ now, subs, members, events }).keys()].filter((d) => !linked.has(d));
  const handles = new Map<string, string>();
  const [states] = await Promise.all([
    readActionStates(admin),
    mapLimit(unnamed, 4, async (did) => {
      const h = await handleFor(did).catch(() => null);
      if (h) handles.set(did, h);
    }),
  ]);
  const all = recommendedActions({ now, subs, members, visits, passBuyers, events, goal, handles });
  const actions = visibleActions(all, states, now);
  return {
    today,
    months,
    goal,
    pace: goalPace(goal, now),
    flow,
    funnel,
    followUps,
    pool,
    actions,
    canceled,
    passBuyers,
    turnout: events ? turnoutBySeries(events, now, TURNOUT_PAST_DAYS) : null,
    newsletter,
    text: headlineText({ today, goal, flow, funnel, followUps, pool, newsletter, actions: actions.open }),
  };
}

export type Scoreboard = Awaited<ReturnType<typeof readScoreboard>>;
