/**
 * The note after a RegenHub night (T-497). Pure: who gets one, which one, and its words. Server reads and the send
 * are in lib/nightFollowupData.ts; the words are data in lib/nightFollowupCopy.ts; the limits that matter at the
 * moment of sending are also enforced in SQL (migration 066, decide_night_followups).
 *
 * Who: the people whose latest RSVP to the night says going (lib/techne/rsvp.ts countGoing), reached by the email this
 * site holds for their Techne account: the member it is linked to (members.did), else the person their Techne sign-in
 * recorded (techne_people, migration 068: the member a confirmed email matched, or their own confirmed email). It never
 * guesses one and never mails an unconfirmed address. Left out, with the reason shown to the steward: unsubscribed
 * from the newsletter, asked for no follow-ups, already sent one in the last 7 days, or a disabled account. People
 * going with no confirmed email on file (not signed in here since T-497, or an email their PDS can't vouch for) are counted
 * (`noEmail`), never mailed.
 * Which note: `member` for a member in standing (lib/memberStanding.ts), `guest` for everyone else.
 */

import { FOLLOWUP_COPY, type FollowupVariant } from "@/lib/nightFollowupCopy";
import { isMemberInStanding, type StandingSubscription } from "@/lib/memberStanding";
import { getSeries, hasEnded, isCancelled, plannedNight, ruleDatesFrom, dateIn, type Series } from "@/lib/series";

export type { FollowupVariant };

/** A night shows on /admin/events for a follow-up from when it ends until this many days after. */
export const FOLLOWUP_WINDOW_DAYS = 3;
/** At most one follow-up per person in this many days, across nights (also enforced in decide_night_followups). */
export const FOLLOWUP_CAP_DAYS = 7;

export type HeldReason = "unsubscribed" | "opted_out" | "this_week" | "disabled";

export const HELD_TEXT: Record<HeldReason, string> = {
  unsubscribed: "unsubscribed from email",
  opted_out: "asked for no follow-ups",
  this_week: "had a follow-up this week",
  disabled: "account disabled",
};

export interface FollowupMember {
  id: number;
  name: string;
  email: string | null;
  did: string | null;
  member_type: string | null;
  disabled: boolean | null;
  /** Migration 065: null = not asked yet, false = said no, true = listed. */
  show_in_directory: boolean | null;
}

/** A Techne account as its sign-ins here recorded it (migration 068 techne_people). */
export interface FollowupTechnePerson {
  did: string;
  handle: string | null;
  name: string | null;
  email: string | null;
  email_confirmed: boolean;
  member_id: number | null;
}

/** How a Techne-only person is named to a steward: their display name, else @handle (never part of their email). */
export function techneName(p: { name: string | null; handle: string | null }): string {
  return p.name || (p.handle ? `@${p.handle}` : "(Techne sign-in)");
}

export interface FollowupPerson {
  /** The RSVP's Techne account: the key a steward's ticks are sent back by. */
  did: string;
  /** Null for someone known only by their Techne sign-in. */
  memberId: number | null;
  /** Shown to the steward. */
  name: string;
  /** For "Hi {first},"; empty = "Hi there,". */
  greetName: string;
  email: string;
  variant: FollowupVariant;
  /** A member who hasn't set up their member page (not listed, and hasn't said no): their note asks them to. */
  askForPage: boolean;
  held: HeldReason | null;
}

export interface FollowupBatch {
  /** Will get a note if the steward clicks Send. */
  send: FollowupPerson[];
  /** Left out, with why. */
  held: FollowupPerson[];
  /** Going, but with no email on file (no member link and no confirmed email from a Techne sign-in). */
  noEmail: number;
}

/** Who an RSVP's Techne account is, as this site knows them. */
export interface RsvpPerson<M extends FollowupMember = FollowupMember> {
  /** The member: linked by DID, else the one this account's confirmed email matched at sign-in (still matching). */
  member: M | undefined;
  /** What their Techne sign-ins here recorded (techne_people), if they ever signed in. */
  techne: FollowupTechnePerson | undefined;
  /** The address this site may use for them, lowercase: the member's, else their own confirmed one. */
  email: string | undefined;
}

/**
 * The one mapping from an RSVP's DID to a person (the follow-ups and /admin/events "Who's coming" both use it): the
 * member linked by `members.did`, else the member a confirmed email matched at sign-in while the two addresses still
 * match (a member row whose email changed since is someone else's now), else a Techne-only person.
 */
export function rsvpPeople<M extends FollowupMember>(facts: {
  members: readonly M[];
  people?: readonly FollowupTechnePerson[];
}): (did: string) => RsvpPerson<M> {
  const byDid = new Map(facts.members.flatMap((m) => (m.did ? [[m.did, m] as const] : [])));
  const byId = new Map(facts.members.map((m) => [m.id, m] as const));
  const techne = new Map((facts.people ?? []).map((p) => [p.did, p] as const));
  return (did) => {
    const t = techne.get(did);
    const ownEmail = t?.email_confirmed ? t.email?.trim().toLowerCase() || undefined : undefined;
    const byEmailLink = t?.member_id != null ? byId.get(t.member_id) : undefined;
    // Two missing addresses are no match: an email link needs this account's confirmed email to still be the member's.
    const member = byDid.get(did) ?? (byEmailLink && ownEmail && byEmailLink.email?.trim().toLowerCase() === ownEmail ? byEmailLink : undefined);
    return { member, techne: t, email: member?.email?.trim().toLowerCase() || ownEmail };
  };
}

/**
 * Who would get a note for one night. `holds`: lowercase email → why it can't get a follow-up now, as the database
 * answers it (migration 066 night_followup_holds: unsubscribed, opted out, or a follow-up this week), the same rule
 * the send applies.
 */
export function followupBatch(input: {
  goingDids: readonly string[];
  members: readonly FollowupMember[];
  /** Techne sign-ins recorded for the going DIDs (techne_people). */
  people?: readonly FollowupTechnePerson[];
  subs: readonly (StandingSubscription & { member_id: number })[];
  holds: ReadonlyMap<string, HeldReason>;
}): FollowupBatch {
  const personOf = rsvpPeople(input);
  const out: FollowupBatch = { send: [], held: [], noEmail: 0 };
  const found: FollowupPerson[] = [];
  for (const did of new Set(input.goingDids)) {
    const { member: m, techne: t, email } = personOf(did);
    if (!email) {
      out.noEmail += 1;
      continue;
    }
    if (m) {
      const member = isMemberInStanding(m, input.subs.filter((s) => s.member_id === m.id));
      found.push({
        did, memberId: m.id, name: m.name, greetName: m.name, email,
        variant: member ? "member" : "guest",
        askForPage: member && m.show_in_directory == null,
        held: m.disabled ? "disabled" : (input.holds.get(email) ?? null),
      });
    } else {
      found.push({
        did, memberId: null, name: techneName(t!), greetName: t!.name ?? "",
        email, variant: "guest", askForPage: false, held: input.holds.get(email) ?? null,
      });
    }
  }
  // One note per email, and a member's own entry wins over a Techne-only account claiming the same address.
  const seen = new Set<string>();
  for (const person of [...found.filter((p) => p.memberId != null), ...found.filter((p) => p.memberId == null)]) {
    if (seen.has(person.email)) continue;
    seen.add(person.email);
    (person.held ? out.held : out.send).push(person);
  }
  const byName = (a: FollowupPerson, b: FollowupPerson) => a.name.localeCompare(b.name);
  out.send.sort(byName);
  out.held.sort(byName);
  return out;
}

/** Nights that may get a follow-up now: ended within FOLLOWUP_WINDOW_DAYS, not cancelled, latest first. */
export function nightsForFollowup<E extends { startAt: string | null; endAt?: string | null; status?: string | null }>(
  events: readonly E[],
  now: Date,
): E[] {
  const end = (e: E) => (e.endAt ? Date.parse(e.endAt) : Date.parse(e.startAt ?? "") + 2 * 3600_000);
  return events
    .filter((e) => e.startAt && hasEnded(e, now) && !isCancelled(e) && now.getTime() - end(e) <= FOLLOWUP_WINDOW_DAYS * 86_400_000)
    .sort((a, b) => end(b) - end(a));
}

const TZ = "America/Denver";

/** "Tuesday, December 1 at 6pm". */
export function whenText(iso: string, timeZone = TZ): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone });
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hourCycle: "h12", timeZone })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const time = `${parts.hour}${parts.minute === "00" ? "" : `:${parts.minute}`}${String(parts.dayPeriod).toLowerCase()}`;
  return `${day} at ${time}`;
}

/** The next night of `series` after `now`: the posted one if there is one (its page), else the rule's date (the series page). */
export function nextNightOf(
  series: Series,
  upcoming: readonly { startAt: string | null; status?: string | null; url: string | null; series?: { slug: string } | null }[],
  now: Date,
  siteUrl: string,
): { when: string; url: string } {
  const base = siteUrl.replace(/\/+$/, "");
  const posted = upcoming
    .filter((e) => e.series?.slug === series.slug && e.startAt && Date.parse(e.startAt) > now.getTime() && !isCancelled(e))
    .sort((a, b) => Date.parse(a.startAt!) - Date.parse(b.startAt!))[0];
  if (posted?.startAt) {
    const url = posted.url ? (posted.url.startsWith("/") ? `${base}${posted.url}` : posted.url) : `${base}/events/${series.slug}`;
    return { when: whenText(posted.startAt, series.timezone), url };
  }
  const today = dateIn(now.toISOString(), series.timezone);
  const night = ruleDatesFrom(series.rule, today, 3)
    .map((d) => plannedNight(series, d))
    .find((n) => Date.parse(n.startsAt) > now.getTime())!;
  return { when: whenText(night.startsAt, series.timezone), url: `${base}/events/${series.slug}` };
}

// ── The note ──────────────────────────────────────────────────────────────────

export interface NoteValues {
  first: string;
  night: string;
  weekday: string;
  series?: string;
  nextWhen?: string;
  nextUrl?: string;
  studioWhen: string;
  studioUrl: string;
  eventsUrl: string;
  membershipUrl: string;
  profileUrl?: string;
}

/** Everything a note needs about one night, the same for everyone who gets it. */
export function nightValues(
  night: { name: string; startAt: string; series: Series | null },
  upcoming: Parameters<typeof nextNightOf>[1],
  now: Date,
  siteUrl: string,
): Omit<NoteValues, "first" | "profileUrl"> {
  const base = siteUrl.replace(/\/+$/, "");
  const studio = getSeries("studio-night")!;
  const nextStudio = nextNightOf(studio, upcoming, now, base);
  const next = night.series ? nextNightOf(night.series, upcoming, now, base) : null;
  return {
    night: night.name,
    weekday: new Date(night.startAt).toLocaleDateString("en-US", { weekday: "long", timeZone: night.series?.timezone ?? TZ }),
    series: night.series?.name,
    nextWhen: next?.when,
    nextUrl: next?.url,
    studioWhen: nextStudio.when,
    studioUrl: nextStudio.url,
    eventsUrl: `${base}/events`,
    membershipUrl: `${base}/membership`,
  };
}

/** The values for one person. */
export function personValues(
  person: Pick<FollowupPerson, "greetName" | "askForPage">,
  night: Omit<NoteValues, "first" | "profileUrl">,
  siteUrl: string,
): NoteValues {
  const first = person.greetName.trim().split(/\s+/)[0] || "there";
  return { ...night, first, profileUrl: person.askForPage ? `${siteUrl.replace(/\/+$/, "")}/portal/profile` : undefined };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Piece = { text: string } | { link: string; url: string };

/** One paragraph of the copy, filled, or null if a value it names is missing. */
function fill(template: string, values: Record<string, string | undefined>): Piece[] | null {
  const pieces: Piece[] = [];
  let missing = false;
  const sub = (s: string) =>
    s.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = values[k];
      if (v == null || v === "") missing = true;
      return v ?? "";
    });
  const re = /\[([^\]]+)\]\(\{(\w+)\}\)/g;
  let at = 0;
  for (const m of template.matchAll(re)) {
    if (m.index! > at) pieces.push({ text: sub(template.slice(at, m.index)) });
    const url = values[m[2]];
    if (!url) missing = true;
    pieces.push({ link: sub(m[1]), url: url ?? "" });
    at = m.index! + m[0].length;
  }
  if (at < template.length) pieces.push({ text: sub(template.slice(at)) });
  return missing ? null : pieces;
}

export interface RenderedNote {
  subject: string;
  html: string;
  text: string;
}

/** The note for one person: subject, HTML and plain text. Footer links: no more follow-ups, and unsubscribe. */
export function renderFollowup(
  variant: FollowupVariant,
  values: NoteValues,
  footer: { optOutUrl: string; unsubscribeUrl: string },
): RenderedNote {
  const copy = FOLLOWUP_COPY[variant];
  const vals = values as unknown as Record<string, string | undefined>;
  const subject = (fill(copy.subject, vals) ?? [{ text: "What's next at RegenHub" }]).map((p) => ("text" in p ? p.text : p.link)).join("");
  const paras = copy.paragraphs.map((p) => fill(p, vals)).filter((p): p is Piece[] => p !== null);
  const htmlParas = paras
    .map(
      (ps) =>
        `<p style="margin: 0 0 14px;">${ps
          .map((p) => ("text" in p ? esc(p.text) : `<a href="${esc(p.url)}" style="color: #4b5a2c;">${esc(p.link)}</a>`))
          .join("")}</p>`,
    )
    .join("\n");
  const textParas = paras.map((ps) => ps.map((p) => ("text" in p ? p.text : `${p.link} (${p.url})`)).join("")).join("\n\n");
  const html = `<!doctype html><html><body style="margin: 0; background: #f4f0e6;">
<div style="font-family: 'EB Garamond', Garamond, 'Iowan Old Style', Palatino, Georgia, serif; font-size: 15px; line-height: 1.55; color: #27231d; max-width: 560px; margin: 0 auto; padding: 24px 20px;">
${htmlParas}
<p style="margin: 18px 0 0;">${esc(FOLLOWUP_COPY.signoff)}</p>
<p style="margin: 28px 0 0; font-size: 12px; color: #6b6152;">${esc(FOLLOWUP_COPY.address)}<br>
<a href="${esc(footer.optOutUrl)}" style="color: #6b6152;">${esc(FOLLOWUP_COPY.noMoreFollowups)}</a> · <a href="${esc(footer.unsubscribeUrl)}" style="color: #6b6152;">${esc(FOLLOWUP_COPY.unsubscribe)}</a></p>
</div></body></html>`;
  const text = `${textParas}\n\n${FOLLOWUP_COPY.signoff}\n\n${FOLLOWUP_COPY.address}\n${FOLLOWUP_COPY.noMoreFollowups}: ${footer.optOutUrl}\n${FOLLOWUP_COPY.unsubscribe}: ${footer.unsubscribeUrl}`;
  return { subject, html, text };
}
