/**
 * "Waiting on you" on the admin home (/admin, T-482): the work queues an admin clears in a day or two, each one line
 * that links to where it's done. The people to talk to (set to end, new members, pass buyers…) are the scoreboard's
 * recommended actions ("What to do next", lib/scoreboardActions.ts), right below on the same page. Past due is in both
 * on purpose: an action can be dismissed, a missed payment stays on the queue until it's paid or ended.
 *
 * A count of `null` means its read failed: the queue says it couldn't check, never "nothing waiting". Anything a
 * person has waited on for more than a day comes first, as late (`lateItems`).
 */
import { ANSWER_WITHIN_HOURS } from "@regenhub/shared/joining";

export interface AdminQueueCounts {
  /** Failures in the most recent lock sync run (0 when it was clean or there was none). */
  lastSyncFailures: number | null;
  quarantinedSlots: number | null;
  /** Door-code changes that failed in the last day (admin_actions `lock_writer_failed`, migration 070). */
  doorWriteFailures: number | null;
  /** Past-due subscriptions (Billing's count; the link opens Members filtered to overdue). */
  pastDue: number | null;
  pendingApplications: number | null;
  pendingFreeDays: number | null;
  /** Hot or cold desk members with no billed subscription on either rail (`isUnbilledDesk`, lib/adminMemberFilters.ts). */
  unbilledDesks: number | null;
  /** Members who asked about a desk from the portal and don't have desk access yet (migration 072). */
  deskAsks?: number | null;
}

/** A door-code writer older than its lease (lib/lockWriterStatus.ts): who held it, since when (already formatted). */
export interface StuckWriter { holder: string; since: string; /** False before migration 070: nothing takes it over yet. */ recovers: boolean }

export interface AdminQueueItem {
  key: keyof AdminQueueCounts | "stuckWriter" | `late-${string}`;
  label: string;
  href: string;
  urgent: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const RULES: { key: keyof AdminQueueCounts; urgent: boolean; href: string; what: string; label: (n: number) => string }[] = [
  { key: "lastSyncFailures", urgent: true, href: "/admin/access?tab=sync", what: "the last lock sync",
    label: (n) => `The last lock sync failed on ${plural(n, "code")}` },
  { key: "quarantinedSlots", urgent: true, href: "/admin/access?tab=sync", what: "quarantined door slots",
    label: (n) => `${plural(n, "door slot")} stuck in quarantine` },
  { key: "doorWriteFailures", urgent: true, href: "/admin/access?tab=sync", what: "door-code changes",
    label: (n) => `${plural(n, "door-code change")} failed in the last day` },
  { key: "pastDue", urgent: true, href: "/admin/members?status=overdue", what: "past-due payments",
    label: (n) => `${plural(n, "subscription")} past due` },
  { key: "pendingApplications", urgent: false, href: "/admin/people?tab=applications", what: "applications",
    label: (n) => `${plural(n, "application")} to review` },
  { key: "pendingFreeDays", urgent: false, href: "/admin/people?tab=freedays", what: "free-day requests",
    label: (n) => `${plural(n, "free-day request")} to review` },
  { key: "deskAsks", urgent: false, href: "/admin/members?status=desk_ask", what: "desk asks",
    label: (n) => `${plural(n, "member")} asked about a desk` },
  { key: "unbilledDesks", urgent: false, href: "/admin/members?status=unbilled_desk", what: "unbilled desk members",
    label: (n) => `${plural(n, "desk member")} not billed: send a checkout link` },
];

/** Something a person is waiting on us for: an application or a free-day request still pending. */
export interface WaitingItem { kind: "application" | "free day"; id: number; name: string; createdAt: string }

/**
 * Late (Aaron, 11-24: "Definitely want to respond within 24 hours, ideally quicker"): each application or free-day
 * request waiting longer than ANSWER_WITHIN_HOURS, oldest first, with its age. Pure.
 */
export function lateItems(waiting: readonly WaitingItem[], nowMs: number, withinHours = ANSWER_WITHIN_HOURS): AdminQueueItem[] {
  return waiting
    .map((w) => ({ w, hours: Math.floor((nowMs - Date.parse(w.createdAt)) / 3_600_000) }))
    .filter(({ hours }) => hours >= withinHours)
    .sort((a, b) => b.hours - a.hours)
    .map(({ w, hours }) => ({
      key: `late-${w.kind === "application" ? "app" : "fd"}-${w.id}` as const,
      urgent: true,
      href: w.kind === "application" ? "/admin/people?tab=applications" : "/admin/people?tab=freedays",
      label: `Late: ${w.name}'s ${w.kind === "application" ? "application" : "free-day request"}, waiting ${ageWords(hours)}`,
    }));
}

/** "31 h", or "3 days" past two days. */
export const ageWords = (hours: number) => hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;

export function adminQueue(c: AdminQueueCounts, stuckWriter: StuckWriter | null = null, late: AdminQueueItem[] = []): AdminQueueItem[] {
  const items: AdminQueueItem[] = [...late];
  if (stuckWriter) {
    items.push({ key: "stuckWriter", urgent: true, href: "/admin/access?tab=sync",
      label: `Door-code writer stuck: held by ${stuckWriter.holder} since ${stuckWriter.since}` +
        (stuckWriter.recovers ? "; the next door-code change frees it" : "; see Door → Lock Sync to free it") });
  }
  for (const r of RULES) {
    const n = c[r.key];
    if (n === undefined) continue;
    if (n === null) items.push({ key: r.key, urgent: r.urgent, href: r.href, label: `Couldn't check ${r.what}: open the page` });
    else if (n > 0) items.push({ key: r.key, urgent: r.urgent, href: r.href, label: r.label(n) });
  }
  return items;
}
