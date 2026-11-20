/**
 * Server half of the night follow-ups (T-497): what /admin/events shows for each night that just ended, and the
 * steward's Send / Skip / Retry. Pure rules are in lib/nightFollowups.ts; who is held (unsubscribed, opted out, a
 * follow-up this week) is one SQL rule (migration 066 night_followup_hold) that the preview and the send both ask, and
 * the decision is one SQL call (decide_night_followups). Every note goes out through the one send function
 * (lib/email.ts sendEmailDetailed). Nothing here runs on a timer: nothing is sent without a steward's click.
 */

import type { createServiceClient } from "@/lib/supabase/admin";
import { sendEmailDetailed } from "@/lib/email";
import { canSignEmailLinks, followupOptoutUrl, unsubscribeUrl } from "@/lib/newsletter";
import { PAYING_STATUSES } from "@/lib/memberStanding";
import { fetchAttendance, fetchCollectiveEvents, fetchPublicRegenosEvent, type CollectiveEvent } from "@/lib/regenos/events";
import {
  followupBatch, nightValues, nightsForFollowup, personValues, renderFollowup,
  type FollowupMember, type FollowupTechnePerson, type FollowupVariant, type HeldReason, type RenderedNote,
} from "@/lib/nightFollowups";

type Admin = ReturnType<typeof createServiceClient>;

const MEMBER_COLUMNS = "id, name, email, did, member_type, disabled, show_in_directory";

/**
 * A failed note may be retried while the provider's idempotency key still holds (Resend: 24 hours), so a note the
 * provider did take is never delivered twice. Same window as retry_night_followups (migration 066).
 */
const RETRY_WITHIN_MS = 23 * 3600_000;

/** One person on the page: names only (a steward needn't be a site admin, so no emails). Keyed by their Techne DID. */
export interface FollowupRow {
  did: string;
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
  /** Sent: how many notes failed and can be tried again now. */
  retryable: number;
  /** Sent: send attempts so far (changes with every click, so the card starts fresh after one). */
  attempts: number;
  /** Open: one rendered note per variant someone would get (footer links inert). */
  previews: Partial<Record<FollowupVariant, RenderedNote & { name: string }>>;
  /** RSVPs couldn't be read from Techne: nothing can be sent until a reload reads them. */
  rsvpsUnread: boolean;
}

/**
 * The DB facts that decide a batch, for the people going to some nights: the members their DIDs are linked to, what
 * their Techne sign-ins recorded (techne_people, migration 067: a member a confirmed email matched, or their own
 * confirmed email), those members' paying subscriptions, and the holds on every email that could be written to.
 */
async function batchFacts(admin: Admin, dids: string[]) {
  const none = { members: [] as FollowupMember[], people: [] as FollowupTechnePerson[], subs: [], holds: new Map<string, HeldReason>() };
  if (dids.length === 0) return none;
  const [byDid, known] = await Promise.all([
    admin.from("members").select(MEMBER_COLUMNS).in("did", dids),
    admin.from("techne_people").select("did, handle, name, email, email_confirmed, member_id").in("did", dids),
  ]);
  if (byDid.error) throw byDid.error;
  // Deployed before migration 067 ran (deploy first, then migrate): follow-ups work as before, members only.
  if (known.error) console.error("[night followups] techne_people read failed; members only:", known.error.message);
  const people = (known.error ? [] : (known.data ?? [])) as FollowupTechnePerson[];
  const rows = [...((byDid.data ?? []) as FollowupMember[])];
  const extra = [...new Set(people.flatMap((p) => (p.member_id != null && !rows.some((m) => m.id === p.member_id) ? [p.member_id] : [])))];
  if (extra.length) {
    const { data, error } = await admin.from("members").select(MEMBER_COLUMNS).in("id", extra);
    if (error) throw error;
    rows.push(...((data ?? []) as FollowupMember[]));
  }
  const ids = rows.map((m) => m.id);
  const emails = [...new Set([
    ...rows.flatMap((m) => (m.email ? [m.email.trim().toLowerCase()] : [])),
    ...people.flatMap((p) => (p.email && p.email_confirmed ? [p.email.trim().toLowerCase()] : [])),
  ])];
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
    people,
    subs: (subs.data ?? []) as { member_id: number; status: string; monthly_cents: number }[],
    holds: new Map(((holds.data ?? []) as { email: string; reason: HeldReason }[]).map((h) => [h.email, h.reason])),
  };
}

const siteBase = () => (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://regenhub.xyz").replace(/\/+$/, "");
const row = (p: { did: string; name: string; variant: FollowupVariant; held: HeldReason | null }): FollowupRow => ({
  did: p.did, name: p.name, variant: p.variant, held: p.held,
});

type SentRow = {
  id: number; batch_id: number; member_id: number | null; email: string; variant: FollowupVariant; status: OutcomeStatus;
  held_reason: string | null; created_at: string; attempts: number;
  subject?: string | null; html?: string | null; body_text?: string | null;
};
const SENT_COLUMNS = "id, batch_id, member_id, email, variant, status, held_reason, created_at, attempts";

/** Mirrors retry_night_followups' choice (migration 066), to show the button; the SQL decides. */
const retryableRow = (r: Pick<SentRow, "status" | "created_at">, now: Date) =>
  r.status === "failed" && now.getTime() - Date.parse(r.created_at) < RETRY_WITHIN_MS;

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
      ? admin.from("night_followups").select(SENT_COLUMNS).in("batch_id", sentIds).order("id")
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
  // A note to someone known only by their Techne sign-in has no member: name it from techne_people.
  const byEmail = new Map<string, string>();
  const techneOnly = [...new Set(outcomeRows.flatMap((o) => (o.member_id == null ? [o.email] : [])))];
  if (techneOnly.length) {
    // Before 067 runs this table is missing: those rows keep "(member removed)", as before.
    const { data, error: tErr } = await admin.from("techne_people").select("email, name, handle").in("email", techneOnly);
    if (tErr) console.error("[night followups] techne_people read failed:", tErr.message);
    for (const p of (data ?? []) as { email: string; name: string | null; handle: string | null }[]) {
      byEmail.set(p.email, p.name || (p.handle ? `@${p.handle}` : "(Techne sign-in)"));
    }
  }

  return nights.map((n, i) => {
    const b = decided.get(n.uri);
    const base: NightFollowupView = {
      eventUri: n.uri, name: n.name, startAt: n.startAt!, url: n.url,
      state: b ? (b.decision === "send" ? "sent" : "skipped") : "open",
      decidedAt: b?.decided_at ?? null,
      send: [], held: [], noEmail: 0, outcomes: [], retryable: 0, attempts: 0, previews: {}, rsvpsUnread: false,
    };
    if (b) {
      const mine = outcomeRows.filter((o) => o.batch_id === b.id);
      base.outcomes = mine.map((o) => ({
        name: (o.member_id && names.get(o.member_id)) || byEmail.get(o.email) || "(member removed)",
        variant: o.variant,
        status: o.status,
        held: (o.held_reason as HeldReason | null) ?? null,
      }));
      base.retryable = mine.filter((o) => retryableRow(o, now)).length;
      base.attempts = mine.reduce((n, o) => n + o.attempts, 0);
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

const footerFor = (email: string) => ({ optOutUrl: followupOptoutUrl(email, siteBase()), unsubscribeUrl: unsubscribeUrl(email, siteBase()) });
const NO_SIGNING_KEY = "Email links can't be signed on this server (no unsubscribe key). Nothing was sent.";

/**
 * Send each row through the one send function and record the outcome. Never throws: a row that couldn't be sent is
 * `failed` with the reason (an outcome the provider can't confirm says so). The note is saved on its row before the
 * first send, and a retry sends the saved note, so a retry is the same message under the same idempotency key. An
 * outcome is written only against the attempt that made it. A rate limit is waited out once, as the provider asks.
 */
async function sendRows(
  admin: Admin,
  rows: readonly SentRow[],
  people: ReadonlyMap<string, { greetName: string; askForPage: boolean }>,
  night: () => Promise<ReturnType<typeof nightValues>>,
): Promise<number> {
  let sent = 0;
  for (const r of rows) {
    let update: Record<string, unknown>;
    try {
      // subject, html and body_text are saved together, so html stands for all three.
      let note = r.html != null ? { subject: r.subject ?? "", html: r.html, text: r.body_text ?? "" } : null;
      if (!note) {
        const who = people.get(r.email) ?? { greetName: "", askForPage: false };
        note = renderFollowup(r.variant, personValues(who, await night(), siteBase()), footerFor(r.email));
        const { data: kept, error } = await admin.from("night_followups")
          .update({ subject: note.subject, html: note.html, body_text: note.text })
          .eq("id", r.id).eq("attempts", r.attempts).eq("status", "sending").select("id");
        if (error) throw new Error(`couldn't save the note before sending: ${error.message}`);
        if (!kept?.length) continue; // another click moved this row on: its outcome is theirs to write
      }
      const mail = { to: r.email, ...note, idempotencyKey: `night-followup-${r.id}` };
      let res = await sendEmailDetailed(mail);
      if (!res.ok && res.rateLimited) {
        await new Promise((ok) => setTimeout(ok, 1100));
        res = await sendEmailDetailed(mail);
      }
      update = res.ok
        ? { status: "sent", provider_id: res.id ?? null, sent_at: new Date().toISOString(), error: null }
        : { status: "failed", error: res.ambiguous ? `not confirmed by the provider: ${res.error ?? ""}` : (res.error ?? "send failed") };
    } catch (err) {
      update = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    if (update.status === "sent") sent += 1;
    const { error } = await admin.from("night_followups").update(update).eq("id", r.id).eq("attempts", r.attempts).eq("status", "sending");
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
 * A steward's Send or Skip for one night. `keep`: the Techne DIDs of the people the steward saw and left ticked; only they can get a
 * note, and only if they still qualify now (a person who unsubscribed since the page loaded is held, a new RSVP
 * isn't added). Send then mails each person in turn and records the outcome.
 */
export async function decideNightFollowups(
  admin: Admin,
  input: { eventUri: string; decision: "send" | "skip"; keep: string[]; stewardDid: string },
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
  let people: { member_id: number | null; email: string; variant: FollowupVariant }[] = [];
  const byEmail = new Map<string, { greetName: string; askForPage: boolean }>();
  if (input.decision === "send") {
    const a = await fetchAttendance(event.uri);
    if (!a) return { ok: false, status: 503, error: "Couldn't read the night's RSVPs from Techne. Try again in a moment." };
    const batch = followupBatch({ goingDids: a.goingDids, ...(await batchFacts(admin, a.goingDids)) });
    const keep = new Set(input.keep);
    const chosen = batch.send.filter((p) => keep.has(p.did));
    if (chosen.length === 0) return { ok: false, status: 400, error: "No one to send to. Skip the night instead." };
    if (!canSignEmailLinks()) return { ok: false, status: 500, error: NO_SIGNING_KEY };
    people = chosen.map((p) => ({ member_id: p.memberId, email: p.email, variant: p.variant }));
    for (const p of chosen) byEmail.set(p.email, { greetName: p.greetName, askForPage: p.askForPage });
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
  const sent = await sendRows(admin, toSend, byEmail, once(() => noteNight(event, now)));
  return { ok: true, sent, failed: toSend.length - sent, held: rows.length - toSend.length };
}

/**
 * Retry a sent night's failed notes, within the provider's idempotency window, each as first rendered and under its own
 * key. migration 066 retry_night_followups claims them under the per-email lock, re-asks the hold rule (an
 * unsubscribe or another note this week since holds them) and audits the click; two clicks can't claim the same
 * attempt. A note left at sending (the request died mid-send) may have gone, so it is never sent again.
 */
export async function retryNightFollowups(admin: Admin, eventUri: string, stewardDid: string, now = new Date()): Promise<DecideResult> {
  const event = await readNight(eventUri);
  if (!event || !event.startAt) return { ok: false, status: 404, error: "Couldn't find that night just now. Reload and try again." };
  if (!canSignEmailLinks()) return { ok: false, status: 500, error: NO_SIGNING_KEY };
  const { data, error } = await admin.rpc("retry_night_followups", { p_event_uri: event.uri, p_actor_did: stewardDid });
  if (error) {
    if (/night_followups_not_sent/.test(error.message ?? "")) return { ok: false, status: 409, error: "Nothing was sent for that night." };
    console.error("[night followups] retry failed:", error);
    return { ok: false, status: 500, error: "Couldn't start the retry. Try again." };
  }
  const touched = (data ?? []) as SentRow[];
  const claimed = touched.filter((r) => r.status === "sending");
  const held = touched.length - claimed.length;
  if (claimed.length === 0) return { ok: true, sent: 0, failed: 0, held };
  // The notes as first rendered come back with the claim; a note never saved (its first render failed) is rendered
  // now, for which the member's name is read. A failed read leaves the greeting plain rather than strand the claim.
  const rows = claimed;
  const unsaved = rows.filter((r) => r.html == null).flatMap((r) => (r.member_id ? [r.member_id] : []));
  const people = new Map<string, { greetName: string; askForPage: boolean }>();
  if (unsaved.length) {
    const { data: members, error: mErr } = await admin.from("members").select("id, name, show_in_directory").in("id", unsaved);
    if (mErr) console.error("[night followups] retry: members read failed, sending with a plain greeting:", mErr);
    const byId = new Map((members ?? []).map((m) => [m.id as number, m as { name: string; show_in_directory: boolean | null }]));
    for (const r of rows) {
      const m = r.member_id ? byId.get(r.member_id) : undefined;
      if (m) people.set(r.email, { greetName: m.name, askForPage: r.variant === "member" && m.show_in_directory == null });
    }
  }
  // A Techne-only person's greeting is their Techne display name (techne_people), as on the first attempt.
  const unsavedTechne = rows.filter((r) => r.html == null && r.member_id == null).map((r) => r.email);
  if (unsavedTechne.length) {
    const { data, error: tErr } = await admin.from("techne_people").select("email, name").in("email", unsavedTechne);
    if (tErr) console.error("[night followups] retry: techne_people read failed, sending with a plain greeting:", tErr);
    for (const p of (data ?? []) as { email: string; name: string | null }[]) {
      if (p.name) people.set(p.email, { greetName: p.name, askForPage: false });
    }
  }
  const sent = await sendRows(admin, rows, people, once(() => noteNight(event, now)));
  return { ok: true, sent, failed: claimed.length - sent, held };
}

/** `fn` called at most once, on first use. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}
