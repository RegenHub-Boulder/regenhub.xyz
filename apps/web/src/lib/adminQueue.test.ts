import { describe, expect, it } from "vitest";
import { adminQueue, type AdminQueueCounts } from "./adminQueue";

const none: AdminQueueCounts = {
  lastSyncFailures: 0, quarantinedSlots: 0, pastDue: 0, pendingApplications: 0, pendingFreeDays: 0, unbilledDesks: 0,
};

describe("adminQueue (Waiting on you)", () => {
  it("is empty when nothing is waiting", () => {
    expect(adminQueue(none)).toEqual([]);
  });

  it("lists each queue with its count, link and urgency, the door and money first", () => {
    const q = adminQueue({ lastSyncFailures: 2, quarantinedSlots: 1, pastDue: 1, pendingApplications: 3, pendingFreeDays: 1, unbilledDesks: 2 });
    expect(q.map((i) => [i.label, i.href, i.urgent])).toEqual([
      ["The last lock sync failed on 2 codes", "/admin/access?tab=sync", true],
      ["1 door slot stuck in quarantine", "/admin/access?tab=sync", true],
      ["1 subscription past due", "/admin/billing", true],
      ["3 applications to review", "/admin/pipeline?tab=applications", false],
      ["1 free-day request to review", "/admin/pipeline?tab=freedays", false],
      ["2 desk members not billed: send a checkout link", "/admin/members?status=no_subscription", false],
    ]);
  });

  it("a failed read says it couldn't check, never that nothing is waiting", () => {
    const q = adminQueue({ ...none, quarantinedSlots: null });
    expect(q).toEqual([{ key: "quarantinedSlots", urgent: true, href: "/admin/access?tab=sync",
      label: "Couldn't check quarantined door slots: open the page" }]);
  });
});
