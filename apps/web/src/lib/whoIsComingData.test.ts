import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseMock } from "../../test/mockSupabase";
import { readWhoIsComing } from "./whoIsComingData";

afterEach(() => vi.unstubAllGlobals());

describe("readWhoIsComing", () => {
  it("doesn't wait on a hanging handle lookup: the list comes back within the budget, without that handle", async () => {
    // The PLC directory never answers (the network edge).
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const admin = makeSupabaseMock({
      selects: {
        members: { data: [{ id: 1, name: "Ana", email: "ana@example.test", did: "did:plc:ana", member_type: "hot_desk", disabled: false, show_in_directory: null }] },
        techne_people: { data: [] },
        subscriptions: { data: [] },
      },
    });
    const t0 = Date.now();
    const [list] = await readWhoIsComing(admin as never, [{ goingRsvps: [{ did: "did:plc:ana", at: "2026-11-20T00:00:00Z" }] }], { withEmails: false, handleBudgetMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(list).toEqual([{ did: "did:plc:ana", name: "Ana", handle: null, kind: "member", plan: "Hot Desk", rsvpAt: "2026-11-20T00:00:00Z" }]);
  });

  it("a failed people read gives null for every night (\"Couldn't load who's coming\"), never a throw", async () => {
    const admin = makeSupabaseMock({ selects: { members: { error: { message: "down" } } } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readWhoIsComing(admin as never, [{ goingRsvps: [{ did: "did:plc:a", at: "" }] }, null], { withEmails: true })).toEqual([null, null]);
  });
});
