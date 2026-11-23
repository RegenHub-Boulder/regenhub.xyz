import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { QuarantinedSlots } from "@/components/admin/QuarantinedSlots";
import { CLEAR_EXPLAINED, explainQuarantine, type QuarantineRow } from "./lockQuarantine";
import { fmtBoulderDateTime } from "./boulderTime";

// Production's rows on 11-23 (Uni's read): guest-code slots 101–108, all from 10-09, no door results recorded.
const prodLike: QuarantineRow[] = [101, 102, 103].map((slot) => ({
  slot, reason: "SET threw or timed out; clear required before reuse", quarantined_at: "2026-10-09T16:12:00Z", door_results: [],
}));

const render = (rows: QuarantineRow[], holders: Record<number, Parameters<typeof explainQuarantine>[1]> = {}) =>
  renderToStaticMarkup(createElement(QuarantinedSlots, {
    slots: rows.map((r) => explainQuarantine(r, holders[r.slot] ?? null, fmtBoulderDateTime)),
    explainer: CLEAR_EXPLAINED,
  }));

describe("Door → Lock Sync: quarantined slots in plain words", () => {
  it("says which slot, since when, why, and what clearing does, with Clear on each and Clear all", () => {
    const html = render(prodLike);
    expect(html).toContain("3 door slots in quarantine");
    expect(html).toContain("Guest-code slot 101");
    expect(html).toContain("since Oct 9, 10:12 AM");
    expect(html).toContain("Setting a door code here failed");
    expect(html).toContain("Nobody holds this slot now");
    expect(html).toContain("The slot is released only if every lock confirms");
    expect((html.match(/aria-label="Clear slot \d+"/g) ?? []).length).toBe(3);
    expect(html).toContain("Clear all 3");
    expect(html).toContain("Recorded as: SET threw or timed out");
  });

  it("names who loses their code, and what each lock said", () => {
    const html = render([
      { slot: 12, reason: "SET incomplete; clear required before reuse", quarantined_at: "2026-11-20T20:00:00Z",
        door_results: [{ entity: "lock.front_door_lock", ok: true }, { entity: "lock.back_door_lock", ok: false, error: "timeout" },
          { entity: "lock.side_door", ok: true, warning: "is low on battery (12%) — the change may not have applied" }] },
      { slot: 140, reason: "Ownership released without confirmed all-door clear", quarantined_at: "2026-11-21T20:00:00Z" },
    ], { 12: { kind: "member", name: "Ana (sample)" }, 140: { kind: "guest", label: "Free Day: Sam" } });
    expect(html).toContain("Member slot 12");
    expect(html).toContain("Ana (sample) holds this slot. Clearing wipes their code");
    expect(html).toContain("Front door lock: confirmed · Back door lock: didn&#x27;t confirm · Side door: answered, but is low on battery (12%)");
    expect(html).toContain("A live guest code (Free Day: Sam) holds this slot");
    expect(html).toContain("revoked, expired or moved");
    expect(html).not.toContain("Clear all 1");
  });

  it("an unknown reason still reads plainly, and nothing renders with no slots", () => {
    expect(explainQuarantine({ slot: 150, reason: "something new", quarantined_at: "2026-11-21T20:00:00Z" }, null, fmtBoulderDateTime).why)
      .toBe("The last write to the locks for this slot didn't finish cleanly.");
    expect(render([])).toBe("");
  });
});
