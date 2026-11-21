/**
 * "Waiting on you" on the admin home (/admin, T-482): the work queues an admin clears in a day or two, each one line
 * that links to where it's done. The people to talk to (set to end, new members, pass buyers…) are the scoreboard's
 * recommended actions ("What to do next", lib/scoreboardActions.ts), right below on the same page. Past due is in both
 * on purpose: an action can be dismissed, a missed payment stays on the queue until it's paid or ended.
 *
 * A count of `null` means its read failed: the queue says it couldn't check, never "nothing waiting".
 */
export interface AdminQueueCounts {
  /** Failures in the most recent lock sync run (0 when it was clean or there was none). */
  lastSyncFailures: number | null;
  quarantinedSlots: number | null;
  /** Past-due subscriptions, as /admin/billing lists them. */
  pastDue: number | null;
  pendingApplications: number | null;
  pendingFreeDays: number | null;
  /** Hot or cold desk members with no billed subscription (BILLED_STATUSES) on either rail. */
  unbilledDesks: number | null;
}

export interface AdminQueueItem {
  key: keyof AdminQueueCounts;
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
  { key: "pastDue", urgent: true, href: "/admin/billing", what: "past-due payments",
    label: (n) => `${plural(n, "subscription")} past due` },
  { key: "pendingApplications", urgent: false, href: "/admin/pipeline?tab=applications", what: "applications",
    label: (n) => `${plural(n, "application")} to review` },
  { key: "pendingFreeDays", urgent: false, href: "/admin/pipeline?tab=freedays", what: "free-day requests",
    label: (n) => `${plural(n, "free-day request")} to review` },
  { key: "unbilledDesks", urgent: false, href: "/admin/members?status=no_subscription", what: "unbilled desk members",
    label: (n) => `${plural(n, "desk member")} not billed: send a checkout link` },
];

export function adminQueue(c: AdminQueueCounts): AdminQueueItem[] {
  const items: AdminQueueItem[] = [];
  for (const r of RULES) {
    const n = c[r.key];
    if (n === null) items.push({ key: r.key, urgent: r.urgent, href: r.href, label: `Couldn't check ${r.what}: open the page` });
    else if (n > 0) items.push({ key: r.key, urgent: r.urgent, href: r.href, label: r.label(n) });
  }
  return items;
}
