/**
 * Server half of the night follow-ups (T-497): what /admin/events shows for each night that just ended, and the
 * steward's Send / Skip / Retry. Pure rules are in lib/nightFollowups.ts; who is held (unsubscribed, opted out, a
 * follow-up this week) is one SQL rule (migration 066 night_followup_hold) that the preview and the send both ask, and
 * the decision is one SQL call (decide_night_followups). Every note goes out through the one send function
 * (lib/email.ts sendEmailDetailed). Nothing here runs on a timer: nothing is sent without a steward's click.
 */

import type { createServiceClient } from "@/lib/supabase/admin";
import { sendEmailDetailed } from "@/lib/email";
import { followupOptoutUrl, unsubscribeUrl } from "@/lib/newsletter";
import { PAYING_STATUSES } from "@/lib/memberStanding";
import { fetchAttendance, fetchCollectiveEvents, fetchPublicRegenosEvent, type CollectiveEvent } from "@/lib/regenos/events";
import {
  followupBatch, nightValues, nightsForFollowup, personValues, renderFollowup,
  type FollowupMember, type FollowupVariant, type HeldReason, type RenderedNote,
} from "@/lib/nightFollowups";

type Admin = ReturnType<typeof createServiceClient>;

const MEMBER_COLUMNS = "id, name, email, did, member_type, disabled, show_in_directory";

/**
 * A row still `sending` this long after it was written is stuck (the request died mid-batch); a `failed` or stuck row
 * may be sent again while the provider's idempotency key still holds (Resend: 24 hours), so a note the provider did
 * take is never sent twice.
 */
const STUCK_AFTER_MS = 5 * 60_000;
const RETRY_WITHIN_MS = 23 * 3600_000;

/** One person on the page: names only (a steward needn't be a site admin, so no emails). */
export interface FollowupRow {
  memberId: number;
  name: string;
  variant: FollowupVariant;
  held: HeldReason | null;
}

export type OutcomeStatus = "sending" | "sent" | "failed" | "held";

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
  outcomes: { name: string; variant: FollowupVariant; status: OutcomeStatus; held: HeldReason | null }[];
  /** Sent: how many notes didn't go (failed, or stuck) and can be tried again now. */
  retryable: number;
  /** Open: one rendered note per variant someone would get (footer links inert). */
  previews: Partial<Record<FollowupVariant, RenderedNote & { name: string }>>;
  /** RSVPs couldn't be read from Techne: nothing can be sent until a reload reads them. */
  rsvpsUnread: boolean;
}

/** The DB facts that decide a batch, for the people going to some nights. */
async function batchFacts(admin: Admin, dids: string[]) {
  if (dids.length === 0) return { members: [] as FollowupMember[], subs: [], holds: new Map<string, HeldReason>() };
  const { data: members, error } = await admin.from("members").select(MEMBER_COLUMNS).in("did", dids);
  if (error) throw error;
  const rows = (members ?? []) as FollowupMember[];
  const ids = rows.map((m) => m.id);
  const emails = [...new Set(rows.flatMap((m) => (m.email ? [m.email.trim().toLowerCase()] : [])))];
  const [subs, holds] = await Promise.all([
    ids.length
      ? admin.from("subscriptions").select("member_id, status, monthly_cents").in("member_id", ids).in("status", PAYING_STATUSES)
      : { data: [], error: null },
    emails.length ? admin.rpc("night_followup_holds", { p_emails: emails }) : { data: [], error: null },
  ]);
  if (subs.error) throw subs.error;
  if (holds.error) throw holds.error;
  return {
    members: rows,
    subs: (subs.data ?? []) as { member_id: number; status: string; monthly_cents: number }[],
    holds: new Map(((holds.data ?? []) as { email: string; reason: HeldReason }[]).map((h) => [h.email, h.reason])),
  };
}

const siteBase = () => (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://regenhub.xyz").replace(/\/+$/, "");
const row = (p: { memberId: number; name: string; variant: FollowupVariant; held: HeldReason | null }): FollowupRow => ({
  memberId: p.memberId, name: p.name, variant: p.variant, held: p.held,
});

type SentRow = { id: number; batch_id: number; member_id: number | null; email: string; variant: FollowupVariant; status: OutcomeStatus; held_reason: string | null; created_at: string };

const retryableRow = (r: Pick<SentRow, "status" | "created_at">, now: Date) => {
  const age = now.getTime() - Date.parse(r.created_at);
  return age < RETRY_WITHIN_MS && (r.status === "failed" || (r.status === "sending" && age > STUCK_AFTER_MS));
};

/**
 * What /admin/events shows: each night of `events` (the page's own calendar read) that ended in the last few days,
 * open or decided. A failed DB read throws (the page shows its error); a failed RSVP read marks that night unread.
 */
export async function readNightFollowups(admin: Admin, events: readonly CollectiveEvent[], now = new Date()): Promise<NightFollowupView[]> {
  const nights = nightsForFollowup(events, now);
  if (nights.length === 0) return [];
  const { data: batches, error } = await admin
    .from("night_followup_batches").select("id, event_uri, decision, decided_at").in("event_uri", nights.map((n) => n.uri));
  if (error) throw error;
  const decided = new Map((batches ?? []).map((b) => [b.event_uri as string, b as { id: number; decision: string; decided_at: string }]));
  const sentIds = [...decided.values()].filter((b) => b.decision === "send").map((b) => b.id);
  // RSVPs only for the nights still open; a decided night shows what was recorded.
  const [going, outcomes] = await Promise.all([
    Promise.all(nights.map((n) => (decided.has(n.uri) ? Promise.resolve(null) : fetchAttendance(n.uri)))),
    sentIds.length
      ? admin.from("night_followups").select("id, batch_id, member_id, email, variant, status, held_reason, created_at").in("batch_id", sentIds).order("id")
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (outcomes.error) throw outcomes.error;
  const outcomeRows = (outcomes.data ?? []) as SentRow[];
  const facts = await batchFacts(admin, [...new Set(going.flatMap((a) => a?.goingDids ?? []))]);
  const names = new Map(facts.members.map((m) => [m.id, m.name]));
  const missing = [...new Set(outcomeRows.flatMap((o) => (o.member_id && !names.has(o.member_id) ? [o.member_id] : [])))];
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
      send: [], held: [], noEmail: 0, outcomes: [], retryable: 0, previews: {}, rsvpsUnread: false,
    };
    if (b) {
      const mine = outcomeRows.filter((o) => o.batch_id === b.id);
      base.outcomes = mine.map((o) => ({
        name: (o.member_id && names.get(o.member_id)) || "(member removed)",
        variant: o.variant,
        status: o.status,
        held: (o.held_reason as HeldReason | null) ?? null,
      }));
      base.retryable = mine.filter((o) => retryableRow(o, now)).length;
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

/** The collective night an at:// URI names, read back from Techne (never trusted from the browser). */
async function readNight(eventUri: string): Promise<CollectiveEvent | null> {
  const m = /^at:\/\/(did:[^/]+)\/community\.lexicon\.calendar\.event\/([^/]+)$/.exec(eventUri);
  return m ? fetchPublicRegenosEvent(m[1], m[2]) : null;
}

/** The footer links for `email`. Throws when there is no key to sign them (checked before anything is recorded). */
const footerFor = (email: string) => ({ optOutUrl: followupOptoutUrl(email, siteBase()), unsubscribeUrl: unsubscribeUrl(email, siteBase()) });

/**
 * Send each row through the one send function and record the outcome. Never throws: a row that couldn't be sent is
 * `failed` with the reason (an outcome the provider can't confirm says so), and Retry may send it again under the
 * same idempotency key.
 */
async function sendRows(
  admin: Admin,
  rows: readonly Pick<SentRow, "id" | "email" | "variant">[],
  people: ReadonlyMap<string, { name: string; askForPage: boolean }>,
  night: ReturnType<typeof nightValues>,
): Promise<number> {
  let sent = 0;
  for (const r of rows) {
    const who = people.get(r.email) ?? { name: "", askForPage: false };
    let update: Record<string, unknown>;
    try {
      const note = renderFollowup(r.variant, personValues(who, night, siteBase()), footerFor(r.email));
      const res = await sendEmailDetailed({ to: r.email, ...note, idempotencyKey: `night-followup-${r.id}` });
      update = res.ok
        ? { status: "sent", provider_id: res.id ?? null, sent_at: new Date().toISOString(), error: null }
        : { status: "failed", error: res.ambiguous ? `not confirmed by the provider: ${res.error ?? ""}` : (res.error ?? "send failed") };
    } catch (err) {
      update = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    if (update.status === "sent") sent += 1;
    const { error } = await admin.from("night_followups").update(update).eq("id", r.id);
    if (error) console.error("[night followups] recording a send failed:", error);
  }
  return sent;
}

/** The note's night values: the next nights from the calendar (a failed read falls back to each series' rule). */
async function noteNight(event: CollectiveEvent, now: Date) {
  const upcoming = (await fetchCollectiveEvents({ after: now.toISOString() })) ?? [];
  return nightValues({ name: event.name, startAt: event.startAt!, series: event.series }, upcoming, now, siteBase());
}

/**
 * A steward's Send or Skip for one night. `keep`: the member ids the steward saw and left ticked; only they can get a
 * note, and only if they still qualify now (a person who unsubscribed since the page loaded is held, a new RSVP
 * isn't added). Send then mails each person in turn and records the outcome.
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
  const byEmail = new Map<string, { name: string; askForPage: boolean }>();
  if (input.decision === "send") {
    const a = await fetchAttendance(event.uri);
    if (!a) return { ok: false, status: 503, error: "Couldn't read the night's RSVPs from Techne. Try again in a moment." };
    const batch = followupBatch({ goingDids: a.goingDids, ...(await batchFacts(admin, a.goingDids)) });
    const keep = new Set(input.keep);
    const chosen = batch.send.filter((p) => keep.has(p.memberId));
    if (chosen.length === 0) return { ok: false, status: 400, error: "No one to send to. Skip the night instead." };
    try {
      footerFor(chosen[0].email);
    } catch (err) {
      console.error("[night followups] can't sign the footer links:", err);
      return { ok: false, status: 500, error: "Email links can't be signed on this server (no unsubscribe key). Nothing was sent." };
    }
    people = chosen.map((p) => ({ member_id: p.memberId, email: p.email, variant: p.variant }));
    for (const p of chosen) byEmail.set(p.email, { name: p.name, askForPage: p.askForPage });
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
    if (/night_followups_decided/.test(error.message ?? "")) return { ok: false, status: 409, error: ALREADY_DECIDED };
    console.error("[night followups] decide failed:", error);
    return { ok: false, status: 500, error: "Couldn't record that. Nothing was sent." };
  }
  const rows = (data ?? []) as SentRow[];
  const toSend = rows.filter((r) => r.status === "sending");
  if (toSend.length === 0) return { ok: true, sent: 0, failed: 0, held: rows.length };
  const sent = await sendRows(admin, toSend, byEmail, await noteNight(event, now));
  return { ok: true, sent, failed: toSend.length - sent, held: rows.length - toSend.length };
}

/**
 * Retry a sent night's notes that didn't go: failed, or stuck at sending (the request died mid-batch), within the
 * provider's idempotency window, under each row's own key, so a note the provider already took isn't delivered twice
 * even if two clicks race.
 */
export async function retryNightFollowups(admin: Admin, eventUri: string, now = new Date()): Promise<DecideResult> {
  const event = await readNight(eventUri);
  if (!event || !event.startAt) return { ok: false, status: 404, error: "Couldn't find that night just now. Reload and try again." };
  const { data: batch, error } = await admin.from("night_followup_batches").select("id, decision").eq("event_uri", event.uri).maybeSingle();
  if (error) return { ok: false, status: 500, error: "Couldn't read the follow-ups. Try again." };
  if (!batch || batch.decision !== "send") return { ok: false, status: 409, error: "Nothing was sent for that night." };
  const { data: rows, error: rErr } = await admin
    .from("night_followups").select("id, batch_id, member_id, email, variant, status, held_reason, created_at")
    .eq("batch_id", batch.id).in("status", ["failed", "sending"]);
  if (rErr) return { ok: false, status: 500, error: "Couldn't read the follow-ups. Try again." };
  const due = ((rows ?? []) as SentRow[]).filter((r) => retryableRow(r, now));
  if (due.length === 0) return { ok: true, sent: 0, failed: 0, held: 0 };
  // Claim each row as read (failed → sending); a row another click changed meanwhile is left to it.
  const claimed: SentRow[] = [];
  for (const r of due) {
    const { data: got } = await admin
      .from("night_followups").update({ status: "sending", error: null })
      .eq("id", r.id).eq("status", r.status).eq("created_at", r.created_at).select("id");
    if (got?.length) claimed.push(r);
  }
  const ids = claimed.flatMap((r) => (r.member_id ? [r.member_id] : []));
  const { data: members } = ids.length
    ? await admin.from("members").select("id, name, show_in_directory").in("id", ids)
    : { data: [] };
  const byId = new Map((members ?? []).map((m) => [m.id as number, m as { name: string; show_in_directory: boolean | null }]));
  const people = new Map(claimed.map((r) => {
    const m = r.member_id ? byId.get(r.member_id) : undefined;
    return [r.email, { name: m?.name ?? "", askForPage: r.variant === "member" && m?.show_in_directory == null }] as const;
  }));
  const sent = await sendRows(admin, claimed, people, await noteNight(event, now));
  return { ok: true, sent, failed: claimed.length - sent, held: 0 };
}
