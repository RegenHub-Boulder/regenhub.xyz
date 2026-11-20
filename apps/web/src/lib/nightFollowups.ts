/**
 * The note after a RegenHub night (T-497). Pure: who gets one, which one, and its words. Server reads and the send
 * are in lib/nightFollowupData.ts; the words are data in lib/nightFollowupCopy.ts; the limits that matter at the
 * moment of sending are also enforced in SQL (migration 066, decide_night_followups).
 *
 * Who: the people whose latest RSVP to the night says going (lib/techne/rsvp.ts countGoing) and whose Techne account
 * is linked to a members row with an email (members.did). That is the only email this site holds for an RSVP; it
 * never guesses one. Left out, with the reason shown to the steward: unsubscribed from the newsletter, asked for no
 * follow-ups, already sent one in the last 7 days, or a disabled account. People who RSVP'd with a Techne account
 * not linked to a member are counted (`noEmail`), never mailed.
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

export interface FollowupPerson {
  memberId: number;
  name: string;
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
  /** Going, but with no member email on file (a Techne account not linked to a member). */
  noEmail: number;
}

/**
 * Who would get a note for one night. `recent` = emails (lowercase) sent a follow-up in the last FOLLOWUP_CAP_DAYS;
 * `unsubscribed` / `optedOut` = lowercase emails.
 */
export function followupBatch(input: {
  goingDids: readonly string[];
  members: readonly FollowupMember[];
  subs: readonly (StandingSubscription & { member_id: number })[];
  unsubscribed: ReadonlySet<string>;
  optedOut: ReadonlySet<string>;
  recent: ReadonlySet<string>;
}): FollowupBatch {
  const byDid = new Map(input.members.flatMap((m) => (m.did ? [[m.did, m] as const] : [])));
  const out: FollowupBatch = { send: [], held: [], noEmail: 0 };
  const seen = new Set<string>();
  for (const did of new Set(input.goingDids)) {
    const m = byDid.get(did);
    const email = m?.email?.trim().toLowerCase();
    if (!m || !email) {
      out.noEmail += 1;
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    const member = isMemberInStanding(m, input.subs.filter((s) => s.member_id === m.id));
    const held: HeldReason | null = m.disabled
      ? "disabled"
      : input.unsubscribed.has(email)
        ? "unsubscribed"
        : input.optedOut.has(email)
          ? "opted_out"
          : input.recent.has(email)
            ? "this_week"
            : null;
    const person: FollowupPerson = {
      memberId: m.id,
      name: m.name,
      email,
      variant: member ? "member" : "guest",
      askForPage: member && m.show_in_directory == null,
      held,
    };
    (held ? out.held : out.send).push(person);
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
  person: Pick<FollowupPerson, "name" | "askForPage">,
  night: Omit<NoteValues, "first" | "profileUrl">,
  siteUrl: string,
): NoteValues {
  const first = person.name.trim().split(/\s+/)[0] || "there";
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
  const subject = (fill(copy.subject, vals) ?? [{ text: "Thanks for coming" }]).map((p) => ("text" in p ? p.text : p.link)).join("");
  const paras = copy.paragraphs.map((p) => fill(p, vals)).filter((p): p is Piece[] => p !== null);
  const htmlParas = paras
    .map(
      (ps) =>
        `<p style="margin: 0 0 14px;">${ps
          .map((p) => ("text" in p ? esc(p.text) : `<a href="${esc(p.url)}" style="color: #2f6b3a;">${esc(p.link)}</a>`))
          .join("")}</p>`,
    )
    .join("\n");
  const textParas = paras.map((ps) => ps.map((p) => ("text" in p ? p.text : `${p.link} (${p.url})`)).join("")).join("\n\n");
  const html = `<!doctype html><html><body style="margin: 0; background: #ffffff;">
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.55; color: #1f2a22; max-width: 560px; margin: 0 auto; padding: 24px 20px;">
${htmlParas}
<p style="margin: 18px 0 0;">${esc(FOLLOWUP_COPY.signoff)}</p>
<p style="margin: 28px 0 0; font-size: 12px; color: #7a857d;">${esc(FOLLOWUP_COPY.address)}<br>
<a href="${esc(footer.optOutUrl)}" style="color: #7a857d;">${esc(FOLLOWUP_COPY.noMoreFollowups)}</a> · <a href="${esc(footer.unsubscribeUrl)}" style="color: #7a857d;">${esc(FOLLOWUP_COPY.unsubscribe)}</a></p>
</div></body></html>`;
  const text = `${textParas}\n\n${FOLLOWUP_COPY.signoff}\n\n${FOLLOWUP_COPY.address}\n${FOLLOWUP_COPY.noMoreFollowups}: ${footer.optOutUrl}\n${FOLLOWUP_COPY.unsubscribe}: ${footer.unsubscribeUrl}`;
  return { subject, html, text };
}
