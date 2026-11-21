import { createHmac, timingSafeEqual } from "crypto";
import { createServiceClient } from "@/lib/supabase/admin";
import { readAll } from "@/lib/supabase/readAll";
import { isMemberInStanding, PAYING_STATUSES, type StandingSubscription } from "@/lib/memberStanding";
type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Newsletter audience, issue keys and signed unsubscribe / opt-out links, for the studio on /admin/mail.
 * (The old biweekly auto-send, its Luma-built issue and the "newsletter note" were retired in T-482.)
 */

// ---------- Unsubscribe tokens ----------

/**
 * Keys that may sign an unsubscribe token, most-preferred first.
 *
 * `NEWSLETTER_UNSUBSCRIBE_SECRET` is the dedicated key — unsubscribe links go
 * out in every issue and live in inboxes forever, so they should not share a
 * secret with the cron bearer token. `CRON_SECRET` stays in the list as a
 * fallback so links already mailed keep verifying while the new var is rolled
 * out; drop it from the environment once you're happy to invalidate them.
 *
 * There is no baked-in default: an empty secret would make every unsubscribe
 * link forgeable, so outside development we would rather fail loudly.
 */
function unsubscribeSecrets(): string[] {
  const secrets = [
    process.env.NEWSLETTER_UNSUBSCRIBE_SECRET,
    process.env.CRON_SECRET,
  ].filter((s): s is string => !!s && s.length > 0);

  if (secrets.length === 0) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "NEWSLETTER_UNSUBSCRIBE_SECRET is not set (and no CRON_SECRET to fall back on) — " +
          "refusing to sign unsubscribe links with a default secret.",
      );
    }
    return ["dev-secret"];
  }
  return secrets;
}

/** Whether this server has a key to sign unsubscribe and opt-out links (false only in production with none set). */
export function canSignEmailLinks(): boolean {
  try {
    return unsubscribeSecrets().length > 0;
  } catch {
    return false;
  }
}

function sign(email: string, secret: string): string {
  return createHmac("sha256", secret).update(`unsub:${email.toLowerCase()}`).digest("hex").slice(0, 32);
}

/** HMAC of the email. The "unsub:" prefix scopes the derivation so the token
 *  can't be confused with anything else derived from the same secret. */
export function unsubscribeToken(email: string): string {
  return sign(email, unsubscribeSecrets()[0]);
}

/** Constant-time check of a token against every accepted signing key. */
export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const given = Buffer.from(token);
  return unsubscribeSecrets().some((secret) => {
    const expected = Buffer.from(sign(email, secret));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function unsubscribeUrl(email: string, siteUrl: string): string {
  const base = siteUrl.replace(/\/$/, "");
  return `${base}/api/newsletter/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;
}

/** The same keys, scoped to "no more notes after nights" (lib/nightFollowups.ts): a different prefix, so neither
 *  token works as the other. */
function signOptout(email: string, secret: string): string {
  return createHmac("sha256", secret).update(`nofollowup:${email.toLowerCase()}`).digest("hex").slice(0, 32);
}

export function verifyFollowupOptoutToken(email: string, token: string): boolean {
  const given = Buffer.from(token);
  return unsubscribeSecrets().some((secret) => {
    const expected = Buffer.from(signOptout(email, secret));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function followupOptoutUrl(email: string, siteUrl: string): string {
  const base = siteUrl.replace(/\/$/, "");
  return `${base}/api/followups/optout?email=${encodeURIComponent(email)}&token=${signOptout(email, unsubscribeSecrets()[0])}`;
}

// ---------- ISO week (for issue keys + biweekly parity) ----------

export function isoWeek(date: Date): { year: number; week: number } {
  // Standard ISO-8601 week algorithm
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

export function issueKeyFor(date: Date): string {
  const { year, week } = isoWeek(date);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// ---------- Audience ----------

export interface Recipient {
  email: string;
  name: string | null;
}

export type NewsletterAudience = "public" | "members";
export const NEWSLETTER_AUDIENCES: readonly NewsletterAudience[] = ["public", "members"];

/** Anything that isn't exactly "members" is public: the default for every issue before 067. */
export function normalizeAudience(value: unknown): NewsletterAudience {
  return value === "members" ? "members" : "public";
}

/**
 * Who an issue goes to. Every row is read (paged past PostgREST's cap) and a failed read throws: a missing
 * unsubscribe list must never mean mailing people who left, nor a short list a full one.
 *  - public: members + interests, deduped, minus unsubscribes.
 *  - members: members in standing (lib/memberStanding.ts: hub friend or desk, or an active/trialing subscription at
 *    $30+) with an email, minus unsubscribes. The stay-in-touch list is never included.
 */
export async function compileAudience(admin: ServiceClient, audience: NewsletterAudience = "public"): Promise<Recipient[]> {
  type Row = { id: number; name: string | null; email: string | null; member_type: string | null };
  const membersOnly = audience === "members";
  const [members, interests, unsubs, subs] = await Promise.all([
    readAll<Row>("members", (f, t) => admin.from("members").select("id, name, email, member_type").eq("disabled", false)
      .not("email", "is", null).order("id", { ascending: true }).range(f, t)),
    membersOnly ? Promise.resolve([] as { name: string | null; email: string | null }[])
      : readAll<{ name: string | null; email: string | null }>("interests", (f, t) => admin.from("interests").select("id, name, email").not("email", "is", null)
        .order("id", { ascending: true }).range(f, t)),
    readAll<{ email: string }>("email_unsubscribes", (f, t) => admin.from("email_unsubscribes").select("email")
      .order("email", { ascending: true }).range(f, t)),
    membersOnly
      ? readAll<StandingSubscription & { id: number; member_id: number }>("subscriptions", (f, t) => admin.from("subscriptions")
        .select("id, member_id, status, monthly_cents").in("status", [...PAYING_STATUSES])
        .order("id", { ascending: true }).range(f, t))
      : Promise.resolve([]),
  ]);

  const subsByMember = new Map<number, StandingSubscription[]>();
  for (const s of subs) subsByMember.set(s.member_id, [...(subsByMember.get(s.member_id) ?? []), s]);

  const blocked = new Set(unsubs.map((u) => u.email.toLowerCase()));
  const seen = new Map<string, Recipient>();
  for (const m of members) {
    if (!m.email) continue;
    if (membersOnly && !isMemberInStanding({ member_type: m.member_type, disabled: false }, subsByMember.get(m.id) ?? [])) continue;
    const key = m.email.toLowerCase();
    if (blocked.has(key)) continue;
    seen.set(key, { email: m.email, name: m.name });
  }
  for (const i of interests) {
    if (!i.email) continue;
    const key = i.email.toLowerCase();
    if (blocked.has(key) || seen.has(key)) continue;
    seen.set(key, { email: i.email, name: i.name ?? null });
  }
  return Array.from(seen.values());
}
