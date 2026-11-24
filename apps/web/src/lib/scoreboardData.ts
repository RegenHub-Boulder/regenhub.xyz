/**
 * Reads what /admin/scoreboard shows. Server only (service client, after the staff gate). Every count is done by
 * the pure functions in lib/scoreboard.ts; this file only fetches rows. Nothing here is written or sent anywhere.
 */
import type { createServiceClient } from "@/lib/supabase/admin";
import { compileAudience } from "@/lib/newsletter";
import { issueProgress } from "@/lib/newsletterSend";
import { fetchAttendance, fetchCollectiveEvents } from "@/lib/regenos/events";
import { mapLimit } from "@/lib/mapLimit";
import { isMissingColumn, membershipInvoices } from "@/lib/onchain/invoiceKind";
import { dateIn } from "@/lib/series";
import { readFreeDayFacts } from "@/lib/freeDayData";
import { readAll } from "@/lib/supabase/readAll";
import { handleFor } from "@/lib/techne/did";
import { AuditAction } from "@/lib/auditLog";
import { readLeakFunnels } from "@/lib/leakFunnelData";
import type { LeakFunnels } from "@/lib/leakFunnel";
import {
  SCOREBOARD_GOALS, SCOREBOARD_TZ, canceledSince, dayPassPool, followupFunnel, funnelByMonth, goalPace, goalProgress, headlineText, lastMonths,
  lastVisits, passBuyersNeverSubscribed, subscriptionFlow, turnoutBySeries,
  type MemberRow, type SubRow, type TurnoutEvent,
} from "@/lib/scoreboard";
import {
  ACTION_RULES, frequentGuests, latestStates, recommendedActions, visibleActions, type ActionMark, type ActionState,
} from "@/lib/scoreboardActions";
import {
  MONTH_TABLE_FROM, firstSignups, monthByMonth, monthStartMs, monthsSince, planBreakdown,
  type DoorRow, type InterestRow, type MonthRow, type PassRow, type PlanChange,
} from "@/lib/scoreboardMonths";

type Admin = ReturnType<typeof createServiceClient>;

const TURNOUT_PAST_DAYS = 60;
/** How far back "Where people drop off" reads the nights' RSVPs: before the first night posted on Techne. */
export const LEAK_NIGHTS_FROM = "2026-01-01T00:00:00Z";
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

/** Day-pass purchases with their rail. `onchain_invoice_id` comes with migration 063: before it, every pass is card. */
async function readPurchases(admin: Admin): Promise<PassRow[]> {
  const read = (cols: string) => readAll<PassRow>("purchases", (f, t) => admin.from("purchases").select(cols)
    .order("id", { ascending: true }).range(f, t));
  try {
    return await read("id, member_id, email, created_at, passes_granted, kind, onchain_invoice_id");
  } catch (e) {
    const { error } = await admin.from("purchases").select("onchain_invoice_id").limit(1);
    if (!isMissingColumn(error)) throw e;
    return read("id, member_id, email, created_at, passes_granted, kind");
  }
}

/** Plans changed in place on a subscription row, from the audit log: a desk → daily switch landing
 *  (`plan_switch_completed`, migration 060), a USDC plan change (`onchain_subscription_changed`) and a card plan
 *  changed now (`card_plan_changed`, logged from T-497 on). Null when unreadable: "day plan → desk" shows blank. */
async function planChangesLogged(admin: Admin): Promise<PlanChange[] | null> {
  const rows = await readAll<{ target_table: string | null; target_id: string | null; payload: Record<string, unknown> | null; created_at: string }>("admin_actions", (f, t) =>
    admin.from("admin_actions").select("id, target_table, target_id, payload, created_at")
      .in("action", [AuditAction.PLAN_SWITCH_COMPLETED, AuditAction.ONCHAIN_SUBSCRIPTION_CHANGED, AuditAction.CARD_PLAN_CHANGED])
      .order("id", { ascending: true }).range(f, t)).catch((e) => {
    // Only "day plan → desk" needs it: that column goes blank, and nothing else breaks.
    console.error("[scoreboard] plan change log read failed", e);
    return null;
  });
  return rows?.flatMap((r) => {
    const p = r.payload ?? {};
    // The subscription: in the payload (060's row targets the member), else the target of a row about a subscription.
    const id = Number(p.subscription_id ?? (r.target_table === "subscriptions" ? r.target_id : NaN));
    const to = p.to ?? p.plan_key;
    return Number.isInteger(id) && id > 0 && typeof p.from === "string" && typeof to === "string"
      ? [{ subscription_id: id, at: r.created_at, from: p.from, to }] : [];
  }) ?? null;
}

/**
 * The rows both the page and the month table count, read once. `since` bounds the dated lists (a day early in UTC,
 * so no Denver-local row of the first month is cut; months outside are ignored by the counts).
 */
async function readRows(admin: Admin, since: string, doorsSince: string) {
  const [rawSubs, members, interests, unsubscribes, applications, purchases, doors, followups, planChanges, freeDays] = await Promise.all([
    readAll<SubRow>("subscriptions", (f, t) => admin.from("subscriptions")
      .select("id, member_id, plan_key, status, monthly_cents, net_cents, payment_rail, created_at, canceled_at, updated_at, " +
        "cancel_at_period_end, admin_canceled_at, admin_cancel_mode, past_due_since, current_period_end")
      .order("id", { ascending: true }).range(f, t)),
    readAll<MemberRow>("members", (f, t) => admin.from("members").select("id, name, email, member_type, disabled, did, created_at")
      .order("id", { ascending: true }).range(f, t)),
    // All of it: the list's size at each month end counts everyone who ever signed up.
    readAll<InterestRow>("interests", (f, t) => admin.from("interests").select("id, email, source_path, member_id, created_at")
      .order("id", { ascending: true }).range(f, t)),
    readAll<{ email: string; created_at: string }>("email_unsubscribes", (f, t) => admin.from("email_unsubscribes")
      .select("email, created_at").order("email", { ascending: true }).range(f, t)),
    readAll<{ created_at: string }>("applications", (f, t) => admin.from("applications").select("id, created_at")
      .gte("created_at", since).order("id", { ascending: true }).range(f, t)),
    readPurchases(admin),
    readAll<DoorRow>("access_logs", (f, t) => admin.from("access_logs").select("id, member_id, slot, method, result, created_at")
      .eq("result", "granted").gte("created_at", doorsSince).order("id", { ascending: true }).range(f, t)),
    followupsSent(admin, since),
    planChangesLogged(admin),
    // The free-day columns (lib/freeDayFunnel.ts, the same facts as People → Free days); a failed read blanks them.
    readFreeDayFacts(admin).catch((e) => {
      console.error("[scoreboard] free-day read failed", e);
      return null;
    }),
  ]);

  const canceledOnchain = rawSubs.filter((s) => s.payment_rail === "onchain" && s.status === "canceled").map((s) => s.id);
  const paid = await paidOnchain(admin, canceledOnchain);
  const subs: SubRow[] = rawSubs.map((s) => (s.payment_rail === "onchain" && s.status === "canceled" ? { ...s, paid: paid.has(s.id) } : s));
  // A note to someone known only by their Techne sign-in (T-497) has no member_id: it counts as the member with that
  // email if they have joined since, so "followed up → joined" sees them.
  const memberByEmail = new Map(members.flatMap((m) => (m.email ? [[m.email.trim().toLowerCase(), m.id] as const] : [])));
  const notes = followups?.map((f) => (f.member_id == null ? { ...f, member_id: memberByEmail.get(f.email) ?? null } : f)) ?? null;
  return { subs, members, interests, unsubscribes, applications, purchases, doors, notes, planChanges, freeDays };
}

type Rows = Awaited<ReturnType<typeof readRows>>;

/** The day before `month` starts in Denver, as an ISO instant: the lower bound for reading a month's rows. */
const dayBefore = (month: string) => new Date(monthStartMs(month) - 86_400_000).toISOString();

const monthRows = (rows: Rows, now: Date): MonthRow[] => monthByMonth({
  subs: rows.subs, members: rows.members, interests: rows.interests, unsubscribes: rows.unsubscribes,
  applications: rows.applications, purchases: rows.purchases, doors: rows.doors,
  followUps: rows.notes ? followupFunnel(rows.notes, rows.subs, monthsSince(MONTH_TABLE_FROM, now)) : null,
  planChanges: rows.planChanges,
  freeDays: rows.freeDays,
}, now);

/** Where reading starts: the earlier of the six-month lists and the month table. */
function readBounds(now: Date) {
  const months = lastMonths(now);
  const first = months[0] < MONTH_TABLE_FROM ? months[0] : MONTH_TABLE_FROM;
  return { months, since: dayBefore(first), doorsSince: dayBefore(MONTH_TABLE_FROM) };
}

/** The month table alone (the CSV download): the same rows and counts as the page's. */
export async function readMonthTable(admin: Admin, now = new Date()): Promise<MonthRow[]> {
  const { since, doorsSince } = readBounds(now);
  return monthRows(await readRows(admin, since, doorsSince), now);
}

/**
 * The collective's own past nights since LEAK_NIGHTS_FROM with who went (the RSVP door). Read strictly, so a calendar
 * that comes back short is unread (null) rather than quietly missing nights; listed events of other groups aren't
 * RegenHub's nights. Going counts already read for the page (`known`) are reused.
 */
async function pastNights(now: Date, known: readonly TurnoutEvent[] | null): Promise<TurnoutEvent[] | null> {
  const events = await fetchCollectiveEvents({ after: LEAK_NIGHTS_FROM, before: now.toISOString(), ownOnly: true, strict: true });
  if (!events) return null;
  const seen = new Map((known ?? []).map((e) => [e.uri, e]));
  const past = events.filter((e) => e.startAt && Date.parse(e.startAt) < now.getTime());
  const going = await mapLimit(past, 6, async (e) => {
    const k = seen.get(e.uri);
    return k && k.going != null ? { goingDids: k.goingDids ?? [] } : fetchAttendance(e.uri);
  });
  // A night whose RSVPs couldn't be read leaves the door unread, rather than counting nobody.
  if (going.some((g) => g == null)) return null;
  return past.map((e, i) => ({ uri: e.uri, name: e.name, startAt: e.startAt, url: e.url, seriesName: null, going: null, goingDids: going[i]!.goingDids ?? [] }));
}

/** "Where people drop off" from rows already read; null (and logged) when it fails, so the rest of the page stands. */
const leaksFrom = async (admin: Admin, rows: Rows, known: TurnoutEvent[] | null, now: Date): Promise<LeakFunnels | null> => {
  try {
    const nights = await pastNights(now, known).catch((e) => {
      console.error("[scoreboard] nights read failed; the RSVP door is unread", e);
      return null;
    });
    return await readLeakFunnels(admin, rows, nights, now);
  } catch (e) {
    console.error("[scoreboard] drop-off read failed", e);
    return null;
  }
};

/** "Where people drop off" alone (its CSV download): the same rows and counts as the page's. */
export async function readLeaks(admin: Admin, now = new Date()): Promise<LeakFunnels> {
  const { since, doorsSince } = readBounds(now);
  const rows = await readRows(admin, since, doorsSince);
  const nights = await pastNights(now, null).catch((e) => {
    console.error("[scoreboard] nights read failed; the RSVP door is unread", e);
    return null;
  });
  return readLeakFunnels(admin, rows, nights, now);
}

/**
 * Everything /admin/scoreboard shows. `leaks` adds "Where people drop off" (the scoreboard page and the MCP summary
 * ask for it; the admin home doesn't, since it reads every night's RSVPs and asks Stripe about card renewals).
 */
export async function readScoreboard(admin: Admin, now = new Date(), opts: { leaks?: boolean } = {}) {
  const { months, since, doorsSince } = readBounds(now);
  const [rows, newsletter, events] = await Promise.all([
    readRows(admin, since, doorsSince),
    newsletterNumbers(admin),
    turnout(now).catch((e) => {
      console.error("[scoreboard] events read failed", e);
      return null;
    }),
  ]);
  const leaksRead = opts.leaks ? leaksFrom(admin, rows, events, now) : Promise.resolve(null);
  const { subs, members, purchases } = rows;

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
  // Signups are people (each email's first signup), as the month table's "added" counts them.
  const funnel = funnelByMonth({ interests: firstSignups(rows.interests), applications: rows.applications, purchases, subs }, months);
  const followUps = rows.notes ? followupFunnel(rows.notes, subs, months) : null;
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
  const leaks = await leaksRead;
  const actions = visibleActions(all, states, now);
  return {
    today,
    months,
    goal,
    pace: goalPace(goal, now),
    flow,
    funnel,
    followUps,
    monthTable: monthRows(rows, now),
    byPlanNow: planBreakdown(subs),
    pool,
    actions,
    canceled,
    passBuyers,
    turnout: events ? turnoutBySeries(events, now, TURNOUT_PAST_DAYS) : null,
    newsletter,
    leaks,
    text: headlineText({ today, goal, flow, funnel, followUps, pool, newsletter, actions: actions.open }),
  };
}

export type Scoreboard = Awaited<ReturnType<typeof readScoreboard>>;
