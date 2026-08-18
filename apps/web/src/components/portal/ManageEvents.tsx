"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { CalendarPlus, Loader2, Lock, Globe, Pencil, Trash2, X, ExternalLink } from "lucide-react";
import {
  EMPTY_EVENT_FORM,
  buildCreateEventInput,
  buildDeleteEventInput,
  buildUpdateEventInput,
  eventBodyToFormValues,
  mintRkey,
  type CalendarEventBody,
  type EventFormValues,
  type EventVisibility,
} from "@/lib/regenos/eventForm";

export interface ManageableEvent {
  uri: string;
  rkey: string;
  name: string;
  startAt: string | null;
  visibility: EventVisibility;
  /** The stored `community.lexicon.calendar.event` body — the edit form's source of truth. */
  value: CalendarEventBody;
  url: string | null;
}

/** RegenHub is in Boulder; pinning the zone keeps server and client renders identical. */
const TZ = "America/Denver";

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

/** Every mutation is a same-origin `/xrpc` POST; the regenOS session cookie rides along by itself. */
async function xrpcPost(nsid: string, body: unknown): Promise<void> {
  const res = await fetch(`/xrpc/${nsid}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.message ?? json?.error ?? `regenOS returned ${res.status}`);
  }
}

export function ManageEvents({
  authority,
  events,
}: {
  authority: string;
  events: ManageableEvent[];
}) {
  // `null` = no form open; a string = the rkey being edited; "" = the new-event form.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<EventFormValues>(EMPTY_EVENT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyRkey, setBusyRkey] = useState<string | null>(null);
  const router = useRouter();

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

  /** Drop the landing page's 5-minute events cache so the change is visible immediately. */
  async function refresh() {
    await fetch("/api/portal/events/revalidate", { method: "POST" }).catch(() => {});
    router.refresh();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await xrpcPost(
          "social.scenius.updateEvent",
          buildUpdateEventInput(form, { authority, rkey: editing }),
        );
      } else {
        await xrpcPost(
          "social.scenius.createEvent",
          buildCreateEventInput(form, { authority, rkey: mintRkey() }),
        );
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
    if (!window.confirm(`Cancel "${event.name}"? Anyone who RSVP'd will be told it's called off.`)) {
      return;
    }
    setBusyRkey(event.rkey);
    setError(null);
    try {
      await xrpcPost(
        "social.scenius.deleteEvent",
        buildDeleteEventInput({ authority, rkey: event.rkey }),
      );
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
        <Button onClick={openCreate} className="btn-primary-glass gap-2 px-6">
          <CalendarPlus className="w-4 h-4" />
          New event
        </Button>
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
                  This event is {form.visibility === "private" ? "private" : "public"}. Visibility and
                  sign-up mode are set when an event is created and can&apos;t be changed here — cancel
                  and recreate it if you need to change them.
                </p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="ev-visibility">Visibility</Label>
                    <select
                      id="ev-visibility"
                      value={form.visibility}
                      onChange={set("visibility")}
                      className="glass-input w-full px-3 py-2 rounded text-sm"
                    >
                      <option value="public">Public — anyone can see it</option>
                      <option value="private">Private — members and invitees only</option>
                    </select>
                  </div>
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
                  </div>
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
  onEdit: (e: ManageableEvent) => void;
  onCancel: (e: ManageableEvent) => void;
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
                <p className="text-sm text-muted mt-0.5">{formatWhen(event.startAt)}</p>
                {event.url && (
                  <a
                    href={event.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-sage hover:text-sage/80 inline-flex items-center gap-1 mt-1"
                  >
                    Public page <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
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
                  Cancel event
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
