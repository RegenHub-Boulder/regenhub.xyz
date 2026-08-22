import { describe, it, expect } from "vitest";
import {
  EMPTY_EVENT_FORM,
  buildCreateEventInput,
  buildDeleteEventInput,
  buildUpdateEventInput,
  eventBodyToFormValues,
  isoToLocalInput,
  localInputToIso,
  mintRkey,
  type EventFormValues,
} from "./eventForm";

const AUTHORITY = "did:plc:regenhubcollective";

const FILLED: EventFormValues = {
  name: "  Repair Café  ",
  description: "  Bring the broken thing.  ",
  startsAt: "2026-09-03T18:00",
  endsAt: "2026-09-03T21:00",
  placeName: " RegenHub ",
  street: " 1515 Walnut St ",
  postalCode: " 80302 ",
  visibility: "private",
  attendance: "approval",
};

describe("datetime round-trip", () => {
  it("gives the AppView an offset-bearing ISO string", () => {
    const iso = localInputToIso("2026-09-03T18:00");
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("round-trips through the local input format", () => {
    // Timezone-independent by construction: whatever zone the runner is in,
    // local → ISO → local must land on the same wall clock.
    const local = "2026-09-03T18:00";
    expect(isoToLocalInput(localInputToIso(local))).toBe(local);
  });

  it("treats blank and unparseable as absent", () => {
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("   ")).toBeNull();
    expect(localInputToIso("not a date")).toBeNull();
    expect(isoToLocalInput(null)).toBe("");
    expect(isoToLocalInput("nonsense")).toBe("");
  });
});

describe("buildCreateEventInput", () => {
  const input = buildCreateEventInput(FILLED, { authority: AUTHORITY, rkey: "ev-1" });

  it("matches the CreateEventInput field names", () => {
    expect(input).toMatchObject({
      authority: AUTHORITY,
      rkey: "ev-1",
      name: "Repair Café",
      description: "Bring the broken thing.",
      placeName: "RegenHub",
      street: "1515 Walnut St",
      postalCode: "80302",
      locality: "Boulder",
      region: "CO",
      country: "US",
      visibility: "private",
      attendance: "approval",
      publicFace: "exact",
    });
  });

  it("sends the address at the exact face so an edit can read it back", () => {
    // A rough face routes street/placeName into the gated event.detail record,
    // which the edit form cannot read — the address would vanish on first save.
    expect(input.publicFace).toBe("exact");
  });

  it("omits empty optional fields rather than sending blanks", () => {
    const sparse = buildCreateEventInput(
      { ...EMPTY_EVENT_FORM, name: "Coworking", startsAt: "2026-09-03T09:00" },
      { authority: AUTHORITY, rkey: "ev-2" },
    );
    expect(Object.keys(sparse).sort()).toEqual(
      [
        "attendance",
        "authority",
        "country",
        "locality",
        "name",
        "publicFace",
        "region",
        "rkey",
        "startsAt",
        "visibility",
      ].sort(),
    );
  });
});

describe("buildUpdateEventInput", () => {
  it("omits visibility and attendance, which updateEvent ignores", () => {
    const input = buildUpdateEventInput(FILLED, { authority: AUTHORITY, rkey: "ev-1" });
    expect(input).not.toHaveProperty("visibility");
    expect(input).not.toHaveProperty("attendance");
    expect(input).toMatchObject({ authority: AUTHORITY, rkey: "ev-1", name: "Repair Café" });
  });

  it("resends every descriptive field — an omitted field is a deleted field upstream", () => {
    const input = buildUpdateEventInput(FILLED, { authority: AUTHORITY, rkey: "ev-1" });
    for (const key of ["description", "startsAt", "endsAt", "placeName", "street", "postalCode"]) {
      expect(input).toHaveProperty(key);
    }
  });
});

describe("buildDeleteEventInput", () => {
  it("is exactly {authority, rkey}", () => {
    expect(buildDeleteEventInput({ authority: AUTHORITY, rkey: "ev-1" })).toEqual({
      authority: AUTHORITY,
      rkey: "ev-1",
    });
  });
});

describe("eventBodyToFormValues", () => {
  it("reads the address out of the locations union, ignoring the geo sibling", () => {
    const values = eventBodyToFormValues(
      {
        name: "Repair Café",
        description: "Bring the broken thing.",
        startsAt: localInputToIso("2026-09-03T18:00")!,
        endsAt: localInputToIso("2026-09-03T21:00")!,
        locations: [
          { $type: "community.lexicon.location.geo", name: "pin" },
          {
            $type: "community.lexicon.location.address",
            name: "RegenHub",
            street: "1515 Walnut St",
            postalCode: "80302",
          },
        ],
      },
      "public",
    );
    expect(values).toEqual({
      name: "Repair Café",
      description: "Bring the broken thing.",
      startsAt: "2026-09-03T18:00",
      endsAt: "2026-09-03T21:00",
      placeName: "RegenHub",
      street: "1515 Walnut St",
      postalCode: "80302",
      visibility: "public",
      attendance: "open",
    });
  });

  it("survives an event with no location or times", () => {
    expect(eventBodyToFormValues({ name: "TBD" }, "private")).toEqual({
      ...EMPTY_EVENT_FORM,
      name: "TBD",
      visibility: "private",
    });
  });
});

describe("mintRkey", () => {
  it("stays inside the atproto rkey charset and is unique per call", () => {
    const keys = new Set(Array.from({ length: 50 }, mintRkey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9._:~-]{1,512}$/);
  });
});
