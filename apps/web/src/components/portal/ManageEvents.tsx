"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { CalendarPlus, CalendarRange, Loader2, Lock, Globe, Pencil, Trash2, X, ArrowRight } from "lucide-react";
import {
  EMPTY_EVENT_FORM,
  HUB_TIMEZONE,
  buildCreateEventInput,
  buildDeleteEventInput,
  buildUpdateEventInput,
  eventBodyToFormValues,
  mintRkey,
  type CalendarEventBody,
  type EventFormValues,
  type EventVisibility,
} from "@/lib/regenos/eventForm";
import { AddSeriesNights } from "@/components/portal/AddSeriesNights";
import type { PlannedNight } from "@/lib/series";
import type { PostedNight } from "@/lib/seriesNights";
import { lumaEventToFormValues, type ParsedLumaEvent } from "@/lib/lumaImport";

export interface ManageableEvent {
  uri: string;
  rkey: string;
  name: string;
  startAt: string | null;
  visibility: EventVisibility;
  /** The stored `community.lexicon.calendar.event` body — the edit form's source of truth. */
  value: CalendarEventBody;
  url: string | null;
  /** How many have RSVP'd going (their own Techne records), when known. */
  going?: number | null;
  /** In the collective's own repo (a listed event belongs to its author: shown, not edited). */
  editable?: boolean;
  /** Its `pub.techne.draft.event.config` ({rkey}-cfg), null when there is none. */
  config?: Record<string, unknown> | null;
  /** Whether its `pub.techne.draft.event.listing` ({rkey}-ctx) exists. */
  hasListing?: boolean;
}

/** RegenHub is in Boulder; pinning the zone keeps server and client renders identical. */
const TZ = HUB_TIMEZONE;

function formatWhen(iso: string | null): string {
  if (!iso) return "No time set";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "No time set";
  return d.toLocaleString("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * How the steward's change reaches the collective's calendar: create, update or delete, with the
 * bodies lib/regenos/eventForm.ts builds (TID keys, the hub's timezone, series names), and the event
 * being changed. StewardEvents sends them as the collective (lib/techne/collectiveEvents.ts).
 */
export type EventWrite = (
  op: "create" | "update" | "delete",
  input: Record<string, unknown>,
  existing?: ManageableEvent,
) => Promise<void>;

export function ManageEvents({
  authority,
  events,
  nights = [],
  posted = [],
  write,
  draft,
}: {
  authority: string;
  events: ManageableEvent[];
  write: EventWrite;
  /** Confirmed series nights not posted yet ("Add the next nights"). */
  nights?: PlannedNight[];
  /** Each posted event's series and start, so a hand-picked night isn't posted twice. */
  posted?: PostedNight[];
  /** Open the new-event form with this filled in (a Luma night, from the Luma check's "Add here"). */
  draft?: ParsedLumaEvent;
}) {
  // `null` = no form open; a string = the rkey being edited; "" = the new-event form.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<EventFormValues>(EMPTY_EVENT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyRkey, setBusyRkey] = useState<string | null>(null);
  // "Add the next nights" is monthly work: behind a button, so this week's nights lead (T-482).
  const [addingNights, setAddingNights] = useState(false);
  const router = useRouter();

  // After mount, so the times fill in the browser's own zone, as the form reads them. Each "Add here" is a
  // navigation that sends a new draft object, so the same night can be opened again after a Cancel. The address
  // then loses its `?fromLuma=`, so a refresh after posting (or a reload) doesn't open the form again.
  // A refresh that lands before the replace still carries the same draft: opened once until the address drops it.
  const openedDraft = useRef<string | null>(null);
  useEffect(() => {
    if (!draft) {
      openedDraft.current = null;
      return;
    }
    const key = `${draft.url}|${draft.startAt}`;
    if (openedDraft.current === key) return;
    openedDraft.current = key;
    setForm(lumaEventToFormValues(draft));
    setError(null);
    setEditing("");
    // Through the router, so its own idea of the address (what a refresh re-requests) drops the draft too.
    const url = new URL(window.location.href);
    url.searchParams.delete("fromLuma");
    router.replace(url.pathname + url.search + url.hash, { scroll: false });
  }, [draft, router]);

  function set<K extends keyof EventFormValues>(key: K) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value as EventFormValues[K] }));
  }

  function openCreate() {
    setForm(EMPTY_EVENT_FORM);
    setError(null);
    setEditing("");
  }

  function openEdit(event: ManageableEvent) {
    setForm(eventBodyToFormValues(event.value, event.visibility));
    setError(null);
    setEditing(event.rkey);
  }

  /** Show the change: the write route already expired the cached Techne reads and `/`. */
  async function refresh() {
    router.refresh();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        const existing = events.find((ev) => ev.rkey === editing);
        await write("update", buildUpdateEventInput(form, { authority, rkey: editing }), existing);
      } else {
        await write("create", buildCreateEventInput(form, { authority, rkey: mintRkey() }));
      }
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel(event: ManageableEvent) {
    if (
      !window.confirm(
        `Remove "${event.name}" from RegenHub's calendar? It is deleted on Techne. People who RSVP'd aren't told automatically.`,
      )
    ) {
      return;
    }
    setBusyRkey(event.rkey);
    setError(null);
    try {
      await write("delete", buildDeleteEventInput({ authority, rkey: event.rkey }), event);
      if (editing === event.rkey) setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusyRkey(null);
    }
  }

  const now = Date.now();
  const upcoming = events.filter((e) => !e.startAt || Date.parse(e.startAt) >= now);
  const past = events.filter((e) => e.startAt && Date.parse(e.startAt) < now).reverse();

  return (
    <div className="space-y-6">
      {error && (
        <div className="glass-panel p-4 border border-red-500/40 bg-red-500/5">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {editing === null ? (
        <>
          <div className="flex flex-wrap gap-3">
            <Button onClick={openCreate} className="btn-primary-glass gap-2 px-6">
              <CalendarPlus className="w-4 h-4" />
              New event
            </Button>
            <Button
              type="button"
              onClick={() => setAddingNights((v) => !v)}
              aria-expanded={addingNights}
              className="btn-glass gap-2 px-6"
              data-testid="add-nights-toggle"
            >
              <CalendarRange className="w-4 h-4" />
              {addingNights ? "Close the next nights" : "Add the next nights"}
            </Button>
          </div>
          {addingNights && (
            <AddSeriesNights
              authority={authority}
              nights={nights}
              posted={posted}
              post={async (body) => {
                await write("create", body);
                await refresh();
              }}
            />
          )}
        </>
      ) : (
        <Card className="glass-panel">
          <CardContent className="p-6">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-lg font-semibold">{editing ? "Edit event" : "New event"}</h2>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="text-muted hover:text-foreground transition-colors"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ev-name">Name</Label>
                <Input id="ev-name" value={form.name} onChange={set("name")} required className="glass-input" />
              </div>

              <div className="space-y-2">
                <Label htmlFor="ev-description">Description</Label>
                <textarea
                  id="ev-description"
                  value={form.description}
                  onChange={set("description")}
                  rows={3}
                  className="glass-input w-full px-3 py-2 rounded text-sm"
                />
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ev-starts">Starts</Label>
                  <Input
                    id="ev-starts"
                    type="datetime-local"
                    value={form.startsAt}
                    onChange={set("startsAt")}
                    required
                    className="glass-input"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ev-ends">Ends</Label>
                  <Input
                    id="ev-ends"
                    type="datetime-local"
                    value={form.endsAt}
                    onChange={set("endsAt")}
                    className="glass-input"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ev-place">Place</Label>
                <Input
                  id="ev-place"
                  value={form.placeName}
                  onChange={set("placeName")}
                  placeholder="RegenHub"
                  className="glass-input"
                />
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ev-street">Street</Label>
                  <Input
                    id="ev-street"
                    value={form.street}
                    onChange={set("street")}
                    placeholder="1515 Walnut St, Suite 200"
                    className="glass-input"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ev-postal">Postal code</Label>
                  <Input
                    id="ev-postal"
                    value={form.postalCode}
                    onChange={set("postalCode")}
                    placeholder="80302"
                    className="glass-input"
                  />
                </div>
              </div>
              <p className="text-xs text-muted">
                Boulder, CO is assumed. The address is published with the event — don&apos;t use one you
                wouldn&apos;t put on a poster.
              </p>

              {editing ? (
                <p className="text-xs text-muted">
                  Public on Techne. Sign-up mode stays as it was set when the event was posted.
                </p>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="ev-attendance">Sign-up</Label>
                  <select
                    id="ev-attendance"
                    value={form.attendance}
                    onChange={set("attendance")}
                    className="glass-input w-full px-3 py-2 rounded text-sm"
                  >
                    <option value="open">Open — RSVP is a seat</option>
                    <option value="approval">Approval — you confirm each person</option>
                  </select>
                  <p className="text-xs text-muted">Public: anyone can see it.</p>
                </div>
              )}

              <div className="flex gap-2">
                <Button type="submit" disabled={saving} className="btn-primary-glass gap-2 px-6">
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {editing ? "Save changes" : "Create event"}
                </Button>
                <Button type="button" onClick={() => setEditing(null)} className="btn-glass px-6">
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <EventList
        title="Upcoming"
        events={upcoming}
        emptyLabel="Nothing on the calendar yet."
        busyRkey={busyRkey}
        onEdit={openEdit}
        onCancel={handleCancel}
      />
      {past.length > 0 && (
        <EventList
          title="Past"
          events={past}
          emptyLabel=""
          busyRkey={busyRkey}
          onEdit={openEdit}
          onCancel={handleCancel}
        />
      )}

      <p className="text-xs text-muted">Times shown in Mountain Time.</p>
    </div>
  );
}

function EventList({
  title,
  events,
  emptyLabel,
  busyRkey,
  onEdit,
  onCancel,
}: {
  title: string;
  events: ManageableEvent[];
  emptyLabel: string;
  busyRkey: string | null;
  onEdit: ((e: ManageableEvent) => void) | null;
  onCancel: ((e: ManageableEvent) => void) | null;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-muted uppercase tracking-wide">{title}</h2>
      {events.length === 0 ? (
        <p className="text-sm text-muted">{emptyLabel}</p>
      ) : (
        events.map((event) => (
          <Card key={event.uri} className="glass-panel">
            <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold truncate">{event.name}</h3>
                  {event.visibility === "private" ? (
                    <Lock className="w-3.5 h-3.5 text-gold shrink-0" aria-label="Private" />
                  ) : (
                    <Globe className="w-3.5 h-3.5 text-sage shrink-0" aria-label="Public" />
                  )}
                </div>
                <p className="text-sm text-muted mt-0.5">
                  {formatWhen(event.startAt)}
                  {typeof event.going === "number" && ` · ${event.going} going`}
                </p>
                {/* In-site now (`/events/<did>/<rkey>`), so a plain internal link — and only for a
                    PUBLIC event, since the public page 404s anything the AppView keeps private. */}
                {event.url && event.visibility === "public" && (
                  <Link
                    href={event.url}
                    className="text-xs text-sage hover:text-sage/80 inline-flex items-center gap-1 mt-1"
                  >
                    View event page <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
              </div>
              {onEdit && onCancel && event.editable !== false && (
                <div className="flex gap-2 shrink-0">
                  <Button onClick={() => onEdit(event)} className="btn-glass gap-2 px-4">
                    <Pencil className="w-3.5 h-3.5" />
                    Edit
                  </Button>
                  <Button
                    onClick={() => onCancel(event)}
                    disabled={busyRkey === event.rkey}
                    className="btn-glass gap-2 px-4 text-red-400"
                  >
                    {busyRkey === event.rkey ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    Remove
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
