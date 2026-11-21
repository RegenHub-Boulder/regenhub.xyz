/**
 * The renamed-night bug (prod, Nov 2026): Fri 18 Dec's 420 Happy Hour was renamed "Ugly Sweater Party 420 Happy
 * Hour", stopped matching its series by name, and "Add the next nights" offered 18 Dec again.
 * Fixed two ways: a night "Add the next nights" posts carries its series page in `uris` (a key a rename doesn't
 * touch), and a night posted before that (no key) still counts by name-in-slot, or by slot alone for suggestions.
 */
import { describe, expect, it } from "vitest";
import { getSeries, plannedNight, seriesOf } from "./series";
import { seriesNightInput, unpostedNights, pickedNight, type PostedNight } from "./seriesNights";
import { putEventBatch, type EventInput } from "./techne/collectiveEvents";
import { buildUpdateEventInput, eventBodyToFormValues, type CalendarEventBody } from "./regenos/eventForm";

const happy = getSeries("happy-hour")!;
const NOW = new Date("2026-12-10T12:00:00Z");
const DEC18 = "2026-12-18T23:20:00.000Z"; // Fri 18 Dec, 4:20pm Denver
const HUB = "did:plc:hubsample";

/** What /admin/events builds from the calendar: each event's series (seriesOf on its record) and start. */
const postedFrom = (records: CalendarEventBody[]): PostedNight[] =>
  records.map((v) => ({ seriesSlug: seriesOf(v)?.slug ?? null, startAt: v.startsAt ?? null }));

const dates = (n: { date: string }[]) => n.map((x) => x.date);

describe("a renamed Happy Hour still counts as that Friday's Happy Hour", () => {
  it("prod case, posted before the key: 'Ugly Sweater Party 420 Happy Hour' on Fri 18 Dec isn't offered again", () => {
    const record = { name: "Ugly Sweater Party 420 Happy Hour", startsAt: DEC18 } as CalendarEventBody;
    expect(seriesOf(record)?.slug).toBe("happy-hour");
    const offered = dates(unpostedNights(happy, postedFrom([record]), NOW));
    expect(offered).not.toContain("2026-12-18");
    expect(offered).toEqual(["2026-12-11", "2026-12-25", "2027-01-01"]);
    expect(pickedNight(happy, "2026-12-18", postedFrom([record]), NOW)).toEqual({ error: "420 Happy Hour is already posted for that date" });
  });

  it("renamed beyond the series name, no key: not on the series page, but its slot is taken, so the date isn't suggested", () => {
    const record = { name: "Ugly Sweater Party", startsAt: DEC18 } as CalendarEventBody;
    expect(seriesOf(record)).toBeNull();
    expect(dates(unpostedNights(happy, postedFrom([record]), NOW))).not.toContain("2026-12-18");
    // It may be a one-off at 4pm rather than the Happy Hour: a steward can still post the Happy Hour by hand.
    expect(pickedNight(happy, "2026-12-18", postedFrom([record]), NOW)).toMatchObject({ night: { date: "2026-12-18" } });
  });

  it("the series name at another time, or a different night that day, is not the series", () => {
    // Friday 18 Dec at 7pm: outside the 4:20 slot (more than 30 minutes off).
    expect(seriesOf({ name: "After-party for 420 Happy Hour", startsAt: "2026-12-19T02:00:00.000Z" })).toBeNull();
    // A Thursday at 4:20: not a rule date.
    expect(seriesOf({ name: "Ugly Sweater Party 420 Happy Hour", startsAt: "2026-12-17T23:20:00.000Z" })).toBeNull();
    // "420 Happy Hours" is not the name as whole words.
    expect(seriesOf({ name: "Ugly Sweater 420 Happy Hours", startsAt: DEC18 })).toBeNull();
    // A late-evening event on 18 Dec leaves the Happy Hour date open.
    expect(dates(unpostedNights(happy, [{ seriesSlug: null, startAt: "2026-12-19T03:00:00.000Z" }], NOW))).toContain("2026-12-18");
  });

  it("a night posted now carries its series page, and a rename through the edit form keeps it", () => {
    const night = plannedNight(happy, "2026-12-18");
    const input = seriesNightInput(night, HUB, "3maaaaaaaaa2a") as unknown as EventInput;
    expect(input.uris).toEqual([{ uri: "https://regenhub.xyz/events/happy-hour", name: "420 Happy Hour" }]);
    const created = putEventBatch(HUB, input, null, NOW).input.writes[0] as { value: CalendarEventBody };

    // The steward renames it in the edit form (which sends no uris), and moves it to 7pm, out of the slot.
    const form = { ...eventBodyToFormValues(created.value, "public"), name: "Ugly Sweater Party" };
    const moved = new Date("2026-12-19T02:00:00.000Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    form.startsAt = `${moved.getFullYear()}-${pad(moved.getMonth() + 1)}-${pad(moved.getDate())}T${pad(moved.getHours())}:${pad(moved.getMinutes())}`;
    const edit = buildUpdateEventInput(form, { authority: HUB, rkey: "3maaaaaaaaa2a" }) as unknown as EventInput;
    const existing = { rkey: "3maaaaaaaaa2a", value: created.value as Record<string, unknown>, config: null, hasListing: true };
    const renamed = putEventBatch(HUB, edit, existing, NOW).input.writes[0] as { value: CalendarEventBody };

    expect(renamed.value.name).toBe("Ugly Sweater Party");
    expect(renamed.value.startsAt).toBe("2026-12-19T02:00:00.000Z");
    expect(seriesOf(renamed.value)?.slug).toBe("happy-hour");
    expect(dates(unpostedNights(happy, postedFrom([renamed.value]), NOW))).not.toContain("2026-12-18");
  });

  it("only https links, at most 10, are written", () => {
    const input: EventInput = {
      rkey: "3maaaaaaaab2a",
      name: "Sample night",
      uris: [{ uri: "javascript:alert(1)" }, { uri: "https://example.test/a", name: "A" }, ...Array(12).fill({ uri: "https://example.test/b" })],
    };
    const value = (putEventBatch(HUB, input, null, NOW).input.writes[0] as unknown as { value: { uris: { uri: string }[] } }).value;
    expect(value.uris[0]).toEqual({ $type: "community.lexicon.calendar.event#uri", uri: "https://example.test/a", name: "A" });
    expect(value.uris).toHaveLength(10);
    // An edit whose links are all refused keeps the event's own (the series key isn't wiped).
    const kept = { uris: [{ uri: "https://regenhub.xyz/events/happy-hour" }], name: "420 Happy Hour" };
    const edited = putEventBatch(HUB, { rkey: "3maaaaaaaab2a", name: "Renamed", uris: [{ uri: "http://insecure.test" }] },
      { rkey: "3maaaaaaaab2a", value: kept, config: null, hasListing: true }, NOW).input.writes[0] as unknown as { value: CalendarEventBody };
    expect(seriesOf(edited.value)?.slug).toBe("happy-hour");
    // So does an empty list.
    const empty = putEventBatch(HUB, { rkey: "3maaaaaaaab2a", name: "Renamed", uris: [] },
      { rkey: "3maaaaaaaab2a", value: kept, config: null, hasListing: true }, NOW).input.writes[0] as unknown as { value: CalendarEventBody };
    expect(seriesOf(empty.value)?.slug).toBe("happy-hour");
  });
});
