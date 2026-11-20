import { describe, expect, it } from "vitest";
import { FOLLOWUP_COPY } from "./nightFollowupCopy";
import {
  followupBatch, nextNightOf, nightValues, nightsForFollowup, personValues, renderFollowup, whenText,
  type FollowupMember,
} from "./nightFollowups";
import { getSeries } from "./series";

const member = (id: number, over: Partial<FollowupMember> = {}): FollowupMember => ({
  id, name: `Person ${id}`, email: `p${id}@example.test`, did: `did:plc:p${id}`, member_type: "day_pass",
  disabled: false, show_in_directory: null, ...over,
});

describe("followupBatch: who gets a note, and which", () => {
  const members = [
    member(1, { name: "Sam Guest" }),
    member(2, { name: "Ana Desk", member_type: "hot_desk" }),
    member(3, { name: "Pat Paying" }),
    member(4, { name: "Cheap Sub" }),
    member(5, { name: "Lapsed" }),
    member(6, { name: "Unsub", email: "Unsub@Example.test" }),
    member(7, { name: "Opted" }),
    member(8, { name: "Weekly" }),
    member(9, { name: "Gone", disabled: true }),
    member(10, { name: "No Email", email: null }),
    member(11, { name: "Listed", member_type: "cold_desk", show_in_directory: true }),
    member(12, { name: "Said no", member_type: "cold_desk", show_in_directory: false }),
    member(13, { name: "Not going" }),
  ];
  const subs = [
    { member_id: 3, status: "active", monthly_cents: 3000 },
    { member_id: 4, status: "active", monthly_cents: 2000 },
    { member_id: 5, status: "past_due", monthly_cents: 5000 },
  ];
  const going = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => `did:plc:p${i}`).concat("did:plc:techne-only", "did:plc:p1");
  const batch = followupBatch({
    goingDids: going,
    members,
    subs,
    holds: new Map([["unsub@example.test", "unsubscribed"], ["p7@example.test", "opted_out"], ["p8@example.test", "this_week"]]),
  });
  const variantOf = (name: string) => batch.send.find((p) => p.name === name)?.variant;

  it("only people going, once each, with a member email on file", () => {
    const names = [...batch.send, ...batch.held].map((p) => p.name);
    expect(names).not.toContain("Not going");
    expect(names.filter((n) => n === "Sam Guest")).toHaveLength(1);
    // A Techne account with no member row, and a member with no email: counted, never mailed.
    expect(batch.noEmail).toBe(2);
  });

  it("member note for a member in standing (desk type, or a paying sub at $30+); guest note otherwise", () => {
    expect(variantOf("Ana Desk")).toBe("member");
    expect(variantOf("Pat Paying")).toBe("member");
    expect(variantOf("Listed")).toBe("member");
    expect(variantOf("Sam Guest")).toBe("guest");
    expect(variantOf("Cheap Sub")).toBe("guest"); // $20 is under the member line
    expect(variantOf("Lapsed")).toBe("guest"); // past due doesn't count
  });

  it("holds the unsubscribed, the opted out, anyone followed up this week, and disabled accounts", () => {
    expect(Object.fromEntries(batch.held.map((p) => [p.name, p.held]))).toEqual({
      Unsub: "unsubscribed",
      Opted: "opted_out",
      Weekly: "this_week",
      Gone: "disabled",
    });
    expect(batch.send.map((p) => p.name)).not.toEqual(expect.arrayContaining(["Unsub", "Opted", "Weekly", "Gone"]));
  });

  it("asks for a member page only from members who haven't decided (not listed, not said no)", () => {
    const ask = (n: string) => batch.send.find((p) => p.name === n)?.askForPage;
    expect(ask("Ana Desk")).toBe(true);
    expect(ask("Listed")).toBe(false);
    expect(ask("Said no")).toBe(false);
    expect(ask("Sam Guest")).toBe(false); // guests aren't asked
  });

  it("with nothing held back, everyone linked is on the send list", () => {
    const b = followupBatch({ goingDids: ["did:plc:p1"], members, subs, holds: new Map() });
    expect(b.send.map((p) => p.email)).toEqual(["p1@example.test"]);
  });
});

describe("nightsForFollowup: the nights a steward can act on", () => {
  const now = new Date("2026-11-20T18:00:00Z");
  const at = (h: number) => new Date(now.getTime() + h * 3600_000).toISOString();
  it("ended within three days, not cancelled, latest first", () => {
    const events = [
      { name: "upcoming", startAt: at(5), endAt: at(7) },
      { name: "running", startAt: at(-1), endAt: at(1) },
      { name: "yesterday", startAt: at(-26), endAt: at(-24) },
      { name: "no end", startAt: at(-50) },
      { name: "cancelled", startAt: at(-30), endAt: at(-28), status: "community.lexicon.calendar.event#cancelled" },
      { name: "too old", startAt: at(-80), endAt: at(-78) },
    ];
    expect(nightsForFollowup(events, now).map((e) => e.name)).toEqual(["yesterday", "no end"]);
  });
});

describe("the note", () => {
  const now = new Date("2026-11-18T17:00:00Z"); // Wednesday, the day after the third Tuesday
  const SITE = "https://regenhub.test";
  const civic = getSeries("civic-tech-night")!;
  const night = nightValues({ name: "Civic Tech Night", startAt: "2026-11-18T01:00:00Z", series: civic }, [], now, SITE);

  it("names the next night of the series from its rule when none is posted, and the posted one when it is", () => {
    expect(night.weekday).toBe("Tuesday");
    expect(night.nextWhen).toBe("Tuesday, December 15 at 6pm");
    expect(night.nextUrl).toBe(`${SITE}/events/civic-tech-night`);
    expect(night.studioWhen).toBe("Tuesday, November 24 at 6pm");
    const posted = nextNightOf(civic, [{ startAt: "2026-12-16T01:00:00Z", url: "/events/did:plc:hub/abc", series: { slug: "civic-tech-night" } }], now, SITE);
    expect(posted).toEqual({ when: "Tuesday, December 15 at 6pm", url: `${SITE}/events/did:plc:hub/abc` });
    expect(whenText("2026-11-27T23:20:00Z")).toBe("Friday, November 27 at 4:20pm");
  });

  const footer = { optOutUrl: `${SITE}/api/followups/optout?x=1`, unsubscribeUrl: `${SITE}/api/newsletter/unsubscribe?x=1` };

  it("guest: thanks, the next night, a Friday demo as a guest, Studio Night, membership; both footer links", () => {
    const n = renderFollowup("guest", personValues({ name: "Sam Rivera", askForPage: false }, night, SITE), footer);
    expect(n.subject).toBe("Thanks for coming to Civic Tech Night");
    expect(n.text).toContain("Hi Sam,");
    expect(n.text).toContain("The next Civic Tech Night is Tuesday, December 15 at 6pm");
    expect(n.text).toMatch(/Fridays before 420 Happy Hour.*as our guest/);
    expect(n.text).toContain("Studio Night");
    expect(n.html).toContain(`href="${SITE}/membership"`);
    expect(n.html).toContain(`href="${footer.optOutUrl.replace(/&/g, "&amp;")}"`);
    expect(n.html).toContain(FOLLOWUP_COPY.unsubscribe);
    expect(n.text).toContain(`${FOLLOWUP_COPY.noMoreFollowups}: ${footer.optOutUrl}`);
  });

  it("member: thanks, the next Studio Night; the member-page line only when asked for", () => {
    const asked = renderFollowup("member", personValues({ name: "Ana", askForPage: true }, night, SITE), footer);
    expect(asked.text).toContain("The next Studio Night is Tuesday, November 24 at 6pm");
    expect(asked.html).toContain(`href="${SITE}/portal/profile"`);
    expect(asked.text).not.toContain("membership");
    const listed = renderFollowup("member", personValues({ name: "Ana", askForPage: false }, night, SITE), footer);
    expect(listed.text).not.toContain("member page");
  });

  it("a night outside any series drops the 'next' line and keeps the rest", () => {
    const oneOff = nightValues({ name: "Open House", startAt: "2026-11-18T01:00:00Z", series: null }, [], now, SITE);
    const n = renderFollowup("guest", personValues({ name: "Sam", askForPage: false }, oneOff, SITE), footer);
    expect(n.text).not.toMatch(/The next (?!one)/); // the series line; Studio Night's "next one" stays
    expect(n.text).toContain("regenhub.xyz/events");
  });

  it("escapes names in the HTML", () => {
    const n = renderFollowup("guest", personValues({ name: "<b>Eve</b>", askForPage: false }, night, SITE), footer);
    expect(n.html).toContain("Hi &lt;b&gt;Eve&lt;/b&gt;,");
    expect(n.html).not.toContain("<b>Eve");
  });

  it("the copy stays plain: no em dashes, no hype words", () => {
    const all = JSON.stringify(FOLLOWUP_COPY);
    expect(all).not.toMatch(/—|–/);
    expect(all).not.toMatch(/\b(amazing|exciting|thrilled|incredible|unlock|journey|vibrant)\b/i);
  });
});
