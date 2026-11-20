/**
 * Server half of the night follow-ups (T-497): what /admin/events shows for each night that just ended, and the
 * steward's Send / Skip. Pure rules are in lib/nightFollowups.ts; the decision and the limits that matter at the
 * moment of sending are one SQL call (migration 066, decide_night_followups). Every note goes out through the one
 * send function (lib/email.ts deliver, via sendEmailDetailed). Nothing here runs on a timer: nothing is sent without
 * a steward's click.
 */

import type { createServiceClient } from "@/lib/supabase/admin";
import { sendEmailDetailed } from "@/lib/email";
import { followupOptoutUrl, unsubscribeUrl } from "@/lib/newsletter";
import { PAYING_STATUSES } from "@/lib/memberStanding";
import { fetchAttendance, fetchCollectiveEvents, fetchPublicRegenosEvent, type CollectiveEvent } from "@/lib/regenos/events";
import {
  FOLLOWUP_CAP_DAYS, followupBatch, nightValues, nightsForFollowup, personValues, renderFollowup,
  type FollowupBatch, type FollowupMember, type FollowupVariant, type HeldReason, type RenderedNote,
} from "@/lib/nightFollowups";

type Admin = ReturnType<typeof createServiceClient>;

const MEMBER_COLUMNS = "id, name, email, did, member_type, disabled, show_in_directory";

/** One person on the page: names only (a steward needn't be a site admin, so no emails). */
export interface FollowupRow {
  memberId: number;
  name: string;
  variant: FollowupVariant;
  held: HeldReason | null;
}

export interface NightFollowupView {
  eventUri: string;
  name: string;
  startAt: string;
  url: string | null;
  /** open: waiting for a steward; sent / skipped: decided. */
  state: "open" | "sent" | "skipped";
  decidedAt: string | null;
  /** Open: who would get a note now, and who is left out. */
  send: FollowupRow[];
  held: FollowupRow[];
  noEmail: number;
  /** Decided (sent): each person's outcome. */
  outcomes: { name: string; variant: FollowupVariant; status: "sending" | "sent" | "failed" | "held"; held: HeldReason | null }[];
  /** Open: one rendered note per variant someone would get (footer links inert). */
  previews: Partial<Record<FollowupVariant, RenderedNote & { name: string }>>;
  /** RSVPs couldn't be read from Techne: nothing can be sent until a reload reads them. */
  rsvpsUnread: boolean;
}

/** The DB facts that decide a batch, for the people going to some nights. */
async function batchFacts(admin: Admin, dids: string[], now: Date) {
  if (dids.length === 0) {
    return { members: [] as FollowupMember[], subs: [], unsubscribed: new Set<string>(), optedOut: new Set<string>(), recent: new Set<string>() };
  }
  const { data: members, error } = await admin.from("members").select(MEMBER_COLUMNS).in("did", dids);
  if (error) throw error;
  const rows = (members ?? []) as FollowupMember[];
  const ids = rows.map((m) => m.id);
  const emails = [...new Set(rows.flatMap((m) => (m.email ? [m.email.trim().toLowerCase()] : [])))];
  const since = new Date(now.getTime() - FOLLOWUP_CAP_DAYS * 86_400_000).toISOString();
  const none = { data: [], error: null };
  const [subs, unsubs, optouts, recent] = await Promise.all([
    ids.length ? admin.from("subscriptions").select("member_id, status, monthly_cents").in("member_id", ids).in("status", PAYING_STATUSES) : none,
    // email_unsubscribes may hold mixed case (older rows): match both forms.
    emails.length ? admin.from("email_unsubscribes").select("email").in("email", [...new Set([...emails, ...rows.flatMap((m) => (m.email ? [m.email.trim()] : []))])]) : none,
    emails.length ? admin.from("night_followup_optouts").select("email").in("email", emails) : none,
    emails.length
      ? admin.from("night_followups").select("email").in("email", emails).in("status", ["sending", "sent"]).gt("created_at", since)
      : none,
  ]);
  for (const r of [subs, unsubs, optouts, recent]) if (r.error) throw r.error;
  const lower = (list: { email: string }[] | null) => new Set((list ?? []).map((r) => r.email.toLowerCase()));
  return {
    members: rows,
    subs: (subs.data ?? []) as { member_id: number; status: string; monthly_cents: number }[],
    unsubscribed: lower(unsubs.data as { email: string }[]),
    optedOut: lower(optouts.data as { email: string }[]),
    recent: lower(recent.data as { email: string }[]),
  };
}

const siteBase = () => (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://regenhub.xyz").replace(/\/+$/, "");
const row = (p: { memberId: number; name: string; variant: FollowupVariant; held: HeldReason | null }): FollowupRow => ({
  memberId: p.memberId, name: p.name, variant: p.variant, held: p.held,
});

/**
 * What /admin/events shows: each night of `events` (the page's own calendar read) that ended in the last few days,
 * open or decided. A failed DB read throws (the page shows its error); a failed RSVP read marks that night unread.
 */
export async function readNightFollowups(admin: Admin, events: readonly CollectiveEvent[], now = new Date()): Promise<NightFollowupView[]> {
  const nights = nightsForFollowup(events, now);
  if (nights.length === 0) return [];
  const uris = nights.map((n) => n.uri);
  const [{ data: batches, error }, going] = await Promise.all([
    admin.from("night_followup_batches").select("id, event_uri, decision, decided_at").in("event_uri", uris),
    Promise.all(nights.map((n) => fetchAttendance(n.uri))),
  ]);
  if (error) throw error;
  const decided = new Map((batches ?? []).map((b) => [b.event_uri as string, b as { id: number; decision: string; decided_at: string }]));
  const sentIds = [...decided.values()].filter((b) => b.decision === "send").map((b) => b.id);
  const { data: outcomeRows, error: oErr } = sentIds.length
    ? await admin.from("night_followups").select("batch_id, member_id, variant, status, held_reason").in("batch_id", sentIds).order("id")
    : { data: [], error: null };
  if (oErr) throw oErr;
  const openDids = nights.flatMap((n, i) => (decided.has(n.uri) ? [] : (going[i]?.goingDids ?? [])));
  const outcomeIds = (outcomeRows ?? []).flatMap((o) => (o.member_id ? [o.member_id as number] : []));
  const facts = await batchFacts(admin, [...new Set(openDids)], now);
  const names = new Map(facts.members.map((m) => [m.id, m.name]));
  const missing = outcomeIds.filter((id) => !names.has(id));
  if (missing.length) {
    const { data, error: nErr } = await admin.from("members").select("id, name").in("id", missing);
    if (nErr) throw nErr;
    for (const m of data ?? []) names.set(m.id, m.name);
  }

  return nights.map((n, i) => {
    const b = decided.get(n.uri);
    const base: NightFollowupView = {
      eventUri: n.uri, name: n.name, startAt: n.startAt!, url: n.url,
      state: b ? (b.decision === "send" ? "sent" : "skipped") : "open",
      decidedAt: b?.decided_at ?? null,
      send: [], held: [], noEmail: 0, outcomes: [], previews: {}, rsvpsUnread: false,
    };
    if (b) {
      base.outcomes = (outcomeRows ?? [])
        .filter((o) => o.batch_id === b.id)
        .map((o) => ({
          name: (o.member_id && names.get(o.member_id)) || "(member removed)",
          variant: o.variant as FollowupVariant,
          status: o.status as "sending" | "sent" | "failed" | "held",
          held: (o.held_reason as HeldReason | null) ?? null,
        }));
      return base;
    }
    const a = going[i];
    if (!a) return { ...base, rsvpsUnread: true };
    const batch = followupBatch({ goingDids: a.goingDids, ...facts });
    const night = nightValues({ name: n.name, startAt: n.startAt!, series: n.series }, events, now, siteBase());
    const previews: NightFollowupView["previews"] = {};
    for (const v of ["guest", "member"] as const) {
      const p = batch.send.find((x) => x.variant === v);
      if (p) previews[v] = { name: p.name, ...renderFollowup(v, personValues(p, night, siteBase()), { optOutUrl: "#", unsubscribeUrl: "#" }) };
    }
    return { ...base, send: batch.send.map(row), held: batch.held.map(row), noEmail: batch.noEmail, previews };
  });
}

const ALREADY_DECIDED = "Someone already decided this night. Reload to see what went out.";

export type DecideResult =
  | { ok: true; sent: number; failed: number; held: number }
  | { ok: false; status: number; error: string };

/** Parse an at:// event URI into the collective event it names, read back from Techne (never trusted from the browser). */
async function readNight(eventUri: string): Promise<CollectiveEvent | null> {
  const m = /^at:\/\/(did:[^/]+)\/community\.lexicon\.calendar\.event\/([^/]+)$/.exec(eventUri);
  return m ? fetchPublicRegenosEvent(m[1], m[2]) : null;
}

async function sendOne(
  admin: Admin,
  r: { id: number; email: string; variant: FollowupVariant },
  name: string,
  askForPage: boolean,
  night: ReturnType<typeof nightValues>,
): Promise<boolean> {
  const base = siteBase();
  const note = renderFollowup(r.variant, personValues({ name, askForPage }, night, base), {
    optOutUrl: followupOptoutUrl(r.email, base),
    unsubscribeUrl: unsubscribeUrl(r.email, base),
  });
  const mail = { to: r.email, ...note, idempotencyKey: `night-followup-${r.id}` };
  let res = await sendEmailDetailed(mail);
  if (!res.ok && res.rateLimited) {
    await new Promise((ok) => setTimeout(ok, 1100));
    res = await sendEmailDetailed(mail);
  }
  const { error } = await admin
    .from("night_followups")
    .update(res.ok ? { status: "sent", provider_id: res.id ?? null, sent_at: new Date().toISOString(), error: null } : { status: "failed", error: res.error ?? "send failed" })
    .eq("id", r.id);
  if (error) console.error("[night followups] recording a send failed:", error);
  return res.ok;
}

/**
 * A steward's Send or Skip for one night. `keep`: the member ids the steward saw and left ticked; only they can get a
 * note, and only if they still qualify now (a person who unsubscribed since the page loaded is held, a new RSVP
 * isn't added). Send then mails each person in turn through the provider seam and records the outcome.
 */
export async function decideNightFollowups(
  admin: Admin,
  input: { eventUri: string; decision: "send" | "skip"; keep: number[]; stewardDid: string },
  now = new Date(),
): Promise<DecideResult> {
  const event = await readNight(input.eventUri);
  if (!event || !event.startAt) return { ok: false, status: 404, error: "Couldn't find that night just now. Reload and try again." };
  if (nightsForFollowup([event], now).length === 0) {
    return { ok: false, status: 409, error: "That night isn't open for follow-ups (not over yet, cancelled, or more than a few days ago)." };
  }
  const { data: already, error: readErr } = await admin.from("night_followup_batches").select("id").eq("event_uri", event.uri).maybeSingle();
  if (readErr) return { ok: false, status: 500, error: "Couldn't record that. Nothing was sent." };
  if (already) return { ok: false, status: 409, error: ALREADY_DECIDED };
  let people: { member_id: number; email: string; variant: FollowupVariant }[] = [];
  let byId = new Map<number, { name: string; askForPage: boolean }>();
  if (input.decision === "send") {
    const a = await fetchAttendance(event.uri);
    if (!a) return { ok: false, status: 503, error: "Couldn't read the night's RSVPs from Techne. Try again in a moment." };
    const batch = followupBatch({ goingDids: a.goingDids, ...(await batchFacts(admin, a.goingDids, now)) });
    const keep = new Set(input.keep);
    const chosen = batch.send.filter((p) => keep.has(p.memberId));
    if (chosen.length === 0) return { ok: false, status: 400, error: "No one to send to. Skip the night instead." };
    people = chosen.map((p) => ({ member_id: p.memberId, email: p.email, variant: p.variant }));
    byId = new Map(chosen.map((p) => [p.memberId, { name: p.name, askForPage: p.askForPage }]));
  }
  const { data, error } = await admin.rpc("decide_night_followups", {
    p_event_uri: event.uri,
    p_event_name: event.name,
    p_event_start: event.startAt,
    p_decision: input.decision,
    p_actor_did: input.stewardDid,
    p_people: people,
  });
  if (error) {
    if (/night_followups_decided/.test(error.message ?? "")) {
      return { ok: false, status: 409, error: ALREADY_DECIDED };
    }
    console.error("[night followups] decide failed:", error);
    return { ok: false, status: 500, error: "Couldn't record that. Nothing was sent." };
  }
  const rows = (data ?? []) as { id: number; member_id: number | null; email: string; variant: FollowupVariant; status: string }[];
  const toSend = rows.filter((r) => r.status === "sending");
  if (toSend.length === 0) return { ok: true, sent: 0, failed: 0, held: rows.length };
  // The next nights, for the note; a failed read falls back to each series' rule.
  const upcoming = (await fetchCollectiveEvents({ after: now.toISOString() })) ?? [];
  const night = nightValues({ name: event.name, startAt: event.startAt, series: event.series }, upcoming, now, siteBase());
  let sent = 0;
  for (const r of toSend) {
    const who = (r.member_id && byId.get(r.member_id)) || { name: "", askForPage: false };
    if (await sendOne(admin, r, who.name, who.askForPage, night)) sent += 1;
  }
  return { ok: true, sent, failed: toSend.length - sent, held: rows.length - toSend.length };
}
