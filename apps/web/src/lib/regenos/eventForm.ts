/**
 * The wire shape of the regenOS event form — pure, so it can be tested without
 * a browser or an AppView.
 *
 * Everything here mirrors `CreateEventInput` in
 * crates/regenos-appview/src/xrpc/event.rs. `updateEvent` deliberately reuses
 * that SAME struct (event.rs:474) and re-runs the whole create fan-out with the
 * same rkey, so **an edit must resend every field it wants to keep** — an
 * omitted `street` is a deleted street, not an untouched one. That is why the
 * edit form prefills from the stored event rather than starting blank.
 *
 * ── Why `publicFace: "exact"` ────────────────────────────────────────────────
 * The AppView's default face is `rough`, which routes street / postal code /
 * place name into the GATED `event.detail` record and publishes only an H3 cell
 * (event.rs `build_public_and_gated`). We can't read that gated record back
 * (`getDetail` is attendee-gated), so a rough event would silently lose its
 * address on the first edit. RegenHub's events happen at a published street
 * address on purpose, so `exact` is both honest and lossless here.
 */

/** The RegenHub collective sits in Boulder; the address lexicon REQUIRES `country`. */
export const BOULDER = { locality: "Boulder", region: "CO", country: "US" } as const;

export type EventVisibility = "public" | "private";
export type EventAttendance = "open" | "approval";

/** The v1 field set, in the browser's own vocabulary (datetime-local strings). */
export interface EventFormValues {
  name: string;
  description: string;
  /** `YYYY-MM-DDTHH:mm`, local — what `<input type="datetime-local">` yields. */
  startsAt: string;
  endsAt: string;
  placeName: string;
  street: string;
  postalCode: string;
  visibility: EventVisibility;
  attendance: EventAttendance;
}

export const EMPTY_EVENT_FORM: EventFormValues = {
  name: "",
  description: "",
  startsAt: "",
  endsAt: "",
  placeName: "",
  street: "",
  postalCode: "",
  visibility: "public",
  attendance: "open",
};

/**
 * `YYYY-MM-DDTHH:mm` (local, no offset) → RFC 3339 with an offset.
 * The AppView's `parse_opt_datetime` 400s on a datetime with no timezone, and
 * `new Date(local).toISOString()` is exactly the "in the viewer's own timezone"
 * reading a datetime-local input means. Empty/unparseable ⇒ null (omitted).
 */
export function localInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** The inverse, for prefilling an edit form. Empty string when there's nothing to show. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A fresh base record key for `createEvent`. Time-ordered so the collection
 * sorts sensibly, and inside atproto's rkey charset (`[A-Za-z0-9._:~-]`).
 */
export function mintRkey(): string {
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `ev-${stamp}${noise}`;
}

/** Trim, and treat blank as absent — the AppView trims too, but an omitted field reads clearer on the wire. */
function present(value: string): string | undefined {
  const t = value.trim();
  return t ? t : undefined;
}

export interface EventInputTarget {
  /** `REGENOS_COLLECTIVE_DID` — the scene the event belongs to. */
  authority: string;
  rkey: string;
}

/** The descriptive half both writes share — name, times, address. */
function describedEvent(
  values: EventFormValues,
  target: EventInputTarget,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    authority: target.authority,
    rkey: target.rkey,
    name: values.name.trim(),
    publicFace: "exact",
    ...BOULDER,
  };
  const description = present(values.description);
  if (description) input.description = description;
  const startsAt = localInputToIso(values.startsAt);
  if (startsAt) input.startsAt = startsAt;
  const endsAt = localInputToIso(values.endsAt);
  if (endsAt) input.endsAt = endsAt;
  const placeName = present(values.placeName);
  if (placeName) input.placeName = placeName;
  const street = present(values.street);
  if (street) input.street = street;
  const postalCode = present(values.postalCode);
  if (postalCode) input.postalCode = postalCode;
  return input;
}

/** The `createEvent` request body — the two controls only exist here. */
export function buildCreateEventInput(
  values: EventFormValues,
  target: EventInputTarget,
): Record<string, unknown> {
  return {
    ...describedEvent(values, target),
    visibility: values.visibility,
    attendance: values.attendance,
  };
}

/**
 * The `updateEvent` request body — the SAME struct minus the two controls,
 * because `updateEvent` ignores them (event.rs:469-471: an edit never moves an
 * event between stores or rewrites its seat config). Sending them anyway would
 * be a lie on the wire, so we don't, and the edit UI doesn't offer them.
 */
export function buildUpdateEventInput(
  values: EventFormValues,
  target: EventInputTarget,
): Record<string, unknown> {
  return describedEvent(values, target);
}

/** The `deleteEvent` request body — `{authority, rkey}` and nothing else (event.rs `DeleteEventInput`). */
export function buildDeleteEventInput(target: EventInputTarget): Record<string, unknown> {
  return { authority: target.authority, rkey: target.rkey };
}

/** The slice of `community.lexicon.location.address` the form round-trips. */
interface AddressItem {
  $type?: string;
  name?: string;
  street?: string;
  postalCode?: string;
}

/** The bits of a stored `community.lexicon.calendar.event` body the form reads back. */
export interface CalendarEventBody {
  name?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  locations?: AddressItem[];
}

/**
 * Read a stored event back into form values. The address rides `locations` as a
 * `community.lexicon.location.address` item (fanout.rs `build_calendar_event`);
 * a `geo`/`hthree` sibling in the same array carries no street, so we pick by type.
 *
 * `attendance` is NOT recoverable here — it lives in the sibling
 * `coop.lexicon.event.config` record, which no read we make returns. It lands as
 * `open` and the edit UI never shows it, which is exactly right: `updateEvent`
 * preserves the stored config regardless.
 */
export function eventBodyToFormValues(
  body: CalendarEventBody,
  visibility: EventVisibility,
): EventFormValues {
  const address = (body.locations ?? []).find(
    (l) => l?.$type === "community.lexicon.location.address",
  );
  return {
    name: body.name ?? "",
    description: body.description ?? "",
    startsAt: isoToLocalInput(body.startsAt),
    endsAt: isoToLocalInput(body.endsAt),
    placeName: address?.name ?? "",
    street: address?.street ?? "",
    postalCode: address?.postalCode ?? "",
    visibility,
    attendance: "open",
  };
}
