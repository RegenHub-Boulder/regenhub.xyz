import { describe, expect, it } from "vitest";
import { adminQueue, type AdminQueueCounts } from "./adminQueue";

const none: AdminQueueCounts = {
  lastSyncFailures: 0, quarantinedSlots: 0, doorWriteFailures: 0, pastDue: 0, pendingApplications: 0, pendingFreeDays: 0, unbilledDesks: 0,
};

describe("adminQueue (Waiting on you)", () => {
  it("is empty when nothing is waiting", () => {
    expect(adminQueue(none)).toEqual([]);
  });

  it("puts the urgent queues (door, money) above the reviews, whatever was passed", () => {
    const q = adminQueue({ ...none, unbilledDesks: 2, pendingApplications: 1, pastDue: 1, lastSyncFailures: 1 });
    expect(q.map((i) => [i.key, i.urgent])).toEqual([
      ["lastSyncFailures", true], ["pastDue", true], ["pendingApplications", false], ["unbilledDesks", false],
    ]);
  });

  it("links each queue to where it's done", () => {
    const all = adminQueue({ lastSyncFailures: 1, quarantinedSlots: 1, doorWriteFailures: 3, pastDue: 2, pendingApplications: 1, pendingFreeDays: 1, unbilledDesks: 1 });
    expect(Object.fromEntries(all.map((i) => [i.key, i.href]))).toEqual({
      lastSyncFailures: "/admin/access?tab=sync", quarantinedSlots: "/admin/access?tab=sync",
      doorWriteFailures: "/admin/access?tab=sync", pastDue: "/admin/members?status=overdue",
      pendingApplications: "/admin/people?tab=applications", pendingFreeDays: "/admin/people?tab=freedays",
      unbilledDesks: "/admin/members?status=unbilled_desk",
    });
    expect(all.find((i) => i.key === "pastDue")?.label).toBe("2 subscriptions past due");
    expect(all.find((i) => i.key === "doorWriteFailures")?.label).toBe("3 door-code changes failed in the last day");
  });

  it("a failed read says it couldn't check, never that nothing is waiting", () => {
    const q = adminQueue({ ...none, quarantinedSlots: null, pendingFreeDays: null });
    expect(q.map((i) => [i.label, i.urgent])).toEqual([
      ["Couldn't check quarantined door slots: open the page", true],
      ["Couldn't check free-day requests: open the page", false],
    ]);
  });

  it("a stuck door-code writer leads the queue, saying who held it and since when", () => {
    const q = adminQueue({ ...none, pastDue: 1 }, { holder: "Web PIN writer", since: "Nov 20, 3:52 PM", recovers: true });
    expect(q[0]).toEqual({
      key: "stuckWriter", urgent: true, href: "/admin/access?tab=sync",
      label: "Door-code writer stuck: held by Web PIN writer since Nov 20, 3:52 PM; the next door-code change frees it",
    });
  });

  it("before migration 070 it doesn't promise the writer frees itself", () => {
    const [item] = adminQueue(none, { holder: "Web PIN writer", since: "Nov 20, 3:52 PM", recovers: false });
    expect(item.label).toBe("Door-code writer stuck: held by Web PIN writer since Nov 20, 3:52 PM; see Door → Lock Sync to free it");
  });
});
