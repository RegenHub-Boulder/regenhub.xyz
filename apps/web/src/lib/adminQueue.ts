/**
 * "Waiting on you" on the admin home (/admin, T-482): the work queues an admin clears in a day or two, each one line
 * that links to where it's done. People to talk to (past due, set to end, new members…) are not here: they are the
 * scoreboard's recommended actions ("What to do next", lib/scoreboardActions.ts), shown right below on the same page.
 */
export interface AdminQueueCounts {
  pendingApplications: number;
  pendingFreeDays: number;
  /** Hot or cold desk members with no live subscription on either rail. */
  unbilledDesks: number;
  /** Failures in the most recent lock sync run (0 when it was clean or there was none). */
  lastSyncFailures: number;
  quarantinedSlots: number;
}

export interface AdminQueueItem {
  key: keyof AdminQueueCounts;
  label: string;
  href: string;
  urgent: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function adminQueue(c: AdminQueueCounts): AdminQueueItem[] {
  const items: AdminQueueItem[] = [];
  if (c.lastSyncFailures > 0) {
    items.push({ key: "lastSyncFailures", urgent: true, href: "/admin/access?tab=sync",
      label: `The last lock sync failed on ${plural(c.lastSyncFailures, "code")}` });
  }
  if (c.quarantinedSlots > 0) {
    items.push({ key: "quarantinedSlots", urgent: true, href: "/admin/access?tab=sync",
      label: `${plural(c.quarantinedSlots, "door slot")} stuck in quarantine` });
  }
  if (c.pendingApplications > 0) {
    items.push({ key: "pendingApplications", urgent: false, href: "/admin/pipeline?tab=applications",
      label: `${plural(c.pendingApplications, "application")} to review` });
  }
  if (c.pendingFreeDays > 0) {
    items.push({ key: "pendingFreeDays", urgent: false, href: "/admin/pipeline?tab=freedays",
      label: `${plural(c.pendingFreeDays, "free-day request")} to review` });
  }
  if (c.unbilledDesks > 0) {
    items.push({ key: "unbilledDesks", urgent: false, href: "/admin/members?status=no_subscription",
      label: `${plural(c.unbilledDesks, "desk member")} not billed: send a checkout link` });
  }
  return items;
}
