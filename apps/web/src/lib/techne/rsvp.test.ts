import { describe, expect, it } from "vitest";
import { countGoing, findOwnRsvp, goingLine, rsvpRecord, statusOf } from "./rsvp";
import { tid, TID_RE } from "./tid";

const EV = "at://did:plc:hub/community.lexicon.calendar.event/3a";
const row = (author: string, rkey: string, status: string, createdAt: string, subject = EV) => ({
  uri: `at://${author}/community.lexicon.calendar.rsvp/${rkey}`,
  author,
  value: { subject: { uri: subject }, status: `community.lexicon.calendar.rsvp#${status}`, createdAt },
});

describe("rsvp records", () => {
  it("writes the documented shape: a strongRef subject and a full status token", () => {
    expect(rsvpRecord({ uri: EV, cid: "bafy" }, "going", new Date("2026-11-16T00:00:00Z"))).toEqual({
      $type: "community.lexicon.calendar.rsvp",
      subject: { uri: EV, cid: "bafy" },
      status: "community.lexicon.calendar.rsvp#going",
      createdAt: "2026-11-16T00:00:00.000Z",
    });
    expect(statusOf("community.lexicon.calendar.rsvp#notgoing")).toBe("notgoing");
    expect(statusOf("something#else")).toBeNull();
  });

  it("counts each person once, by their latest answer, for this event only", () => {
    const a = countGoing(
      [
        row("did:plc:ana", "1", "going", "2026-11-01T00:00:00Z"),
        row("did:plc:ana", "2", "notgoing", "2026-11-02T00:00:00Z"),
        row("did:plc:jo", "3", "notgoing", "2026-11-01T00:00:00Z"),
        row("did:plc:jo", "4", "going", "2026-11-03T00:00:00Z"),
        row("did:plc:sam", "5", "going", "2026-11-01T00:00:00Z"),
        row("did:plc:sam", "6", "going", "2026-11-04T00:00:00Z"),
        row("did:plc:lee", "7", "interested", "2026-11-01T00:00:00Z"),
        row("did:plc:max", "8", "going", "2026-11-01T00:00:00Z", "at://did:plc:hub/community.lexicon.calendar.event/other"),
      ],
      EV,
    );
    expect(a.goingDids.sort()).toEqual(["did:plc:jo", "did:plc:sam"]);
    // Each with when their latest answer was made (Ana's later "not going" took her off the list).
    expect([...a.goingRsvps].sort((x, y) => x.did.localeCompare(y.did))).toEqual([
      { did: "did:plc:jo", at: "2026-11-03T00:00:00Z" },
      { did: "did:plc:sam", at: "2026-11-04T00:00:00Z" },
    ]);
    expect(goingLine(a)).toBe("2 going");
    expect(goingLine({ going: 0 })).toBe("No RSVPs yet");
  });

  it("finds the viewer's own latest RSVP so a change rewrites it", () => {
    expect(
      findOwnRsvp([row("did:plc:me", "old", "going", "2026-11-01T00:00:00Z"), row("did:plc:me", "new", "notgoing", "2026-11-02T00:00:00Z")], EV),
    ).toEqual({ rkey: "new", status: "notgoing" });
    expect(findOwnRsvp([], EV)).toBeNull();
  });

  it("mints TIDs, the key type the rsvp lexicon declares", () => {
    expect(tid(1_700_000_000_000_000n, 0)).toMatch(TID_RE);
    expect(tid(1_700_000_000_000_001n, 0) > tid(1_700_000_000_000_000n, 0)).toBe(true);
  });
});
