import { describe, expect, it } from "vitest";
import { adminQueue, type AdminQueueCounts } from "./adminQueue";

const none: AdminQueueCounts = {
  lastSyncFailures: 0, quarantinedSlots: 0, pastDue: 0, pendingApplications: 0, pendingFreeDays: 0, unbilledDesks: 0,
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
    const all = adminQueue({ lastSyncFailures: 1, quarantinedSlots: 1, pastDue: 2, pendingApplications: 1, pendingFreeDays: 1, unbilledDesks: 1 });
    expect(Object.fromEntries(all.map((i) => [i.key, i.href]))).toEqual({
      lastSyncFailures: "/admin/access?tab=sync", quarantinedSlots: "/admin/access?tab=sync", pastDue: "/admin/members?status=overdue",
      pendingApplications: "/admin/people?tab=applications", pendingFreeDays: "/admin/people?tab=freedays",
      unbilledDesks: "/admin/members?status=no_subscription",
    });
    expect(all.find((i) => i.key === "pastDue")?.label).toBe("2 subscriptions past due");
  });

  it("a failed read says it couldn't check, never that nothing is waiting", () => {
    const q = adminQueue({ ...none, quarantinedSlots: null, pendingFreeDays: null });
    expect(q.map((i) => [i.label, i.urgent])).toEqual([
      ["Couldn't check quarantined door slots: open the page", true],
      ["Couldn't check free-day requests: open the page", false],
    ]);
  });
});
