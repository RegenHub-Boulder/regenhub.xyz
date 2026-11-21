/**
 * Every "Sign in with Techne" leaves a known person (T-497, Aaron 11-20: "If people sign up to a Techne account,
 * shouldn't we get their email right away?"). At the callback: read the account's email from its own PDS
 * (`com.atproto.server.getSession`, granted by the sign-in's `transition:email` scope, lib/techne/session.ts), its
 * public display name, and record them (migration 067 record_techne_sign_in): the person, the member they are (by
 * members.did, or a confirmed email matching a member with no Techne account), and a confirmed email on the
 * stay-in-touch list unless it is there already, unsubscribed, or the person said "No thanks".
 *
 * Nothing here opens the portal, a door code or billing: the member link is only for knowing who someone is. Every
 * read is best-effort: a sign-in never fails because the email or the name couldn't be read.
 */

import type { createServiceClient } from "@/lib/supabase/admin";
import type { Session } from "./call";
import { fetchTechneProfile } from "./profile";

type Admin = ReturnType<typeof createServiceClient>;

const READ_WAIT_MS = 3000;
/** The display name is only a greeting: the sign-in's redirect never waits longer than this for it. */
const NAME_WAIT_MS = 1500;

export interface AccountEmail {
  email: string;
  confirmed: boolean;
}

/** Pure: getSession's answer → the account's email, if it is this DID's and looks like an address. */
export function parseAccountEmail(did: string, body: unknown): AccountEmail | null {
  const b = body as { did?: unknown; email?: unknown; emailConfirmed?: unknown } | null;
  if (!b || b.did !== did || typeof b.email !== "string") return null;
  const email = b.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) return null;
  return { email, confirmed: b.emailConfirmed === true };
}

/** The signed-in account's email from its own PDS, or null (scope not granted, PDS slow or down, no email). */
export async function readAccountEmail(session: Session): Promise<AccountEmail | null> {
  try {
    const res = await session.fetchHandler("/xrpc/com.atproto.server.getSession", {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(READ_WAIT_MS),
    });
    if (!res.ok) return null;
    return parseAccountEmail(session.did, await res.json());
  } catch {
    return null;
  }
}

export interface RecordedPerson {
  memberId: number | null;
  memberLink: "did" | "email" | null;
  /** This sign-in just put them on the stay-in-touch list: show the one-time "We'll send you RegenHub news" line. */
  newsletterAdded: boolean;
}

/** Save one sign-in (migration 067 record_techne_sign_in). Throws on a database error; the callback logs it and carries on. */
export async function recordSignIn(
  admin: Admin,
  p: { did: string; handle: string | null; name: string | null; email: AccountEmail | null },
): Promise<RecordedPerson> {
  const { data, error } = await admin.rpc("record_techne_sign_in", {
    p_did: p.did,
    p_handle: p.handle,
    p_name: p.name,
    p_email: p.email?.email ?? null,
    p_email_confirmed: p.email?.confirmed ?? false,
  });
  if (error) throw new Error(`record_techne_sign_in: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { member_id: number | null; member_link: "did" | "email" | null; newsletter_added: boolean }
    | undefined;
  return { memberId: row?.member_id ?? null, memberLink: row?.member_link ?? null, newsletterAdded: row?.newsletter_added === true };
}

/**
 * The callback's whole step: read the email and the name, then record. Never throws. `homeAccount`: the account is on
 * the home PDS (techne.town), the only server whose "confirmed" is taken; any other server's email is kept as
 * unconfirmed, so it links no member, joins no list and gets no note (anyone can run a PDS that claims an address).
 */
export async function rememberPerson(
  admin: Admin,
  o: { did: string; handle: string | null; session: Session | null; homeAccount: boolean },
): Promise<RecordedPerson | null> {
  try {
    const [read, profile] = await Promise.all([
      o.session ? readAccountEmail(o.session) : Promise.resolve(null),
      Promise.race([
        fetchTechneProfile(o.did, { revalidate: 0 }).catch(() => null),
        new Promise<null>((ok) => setTimeout(() => ok(null), NAME_WAIT_MS)),
      ]),
    ]);
    const email = read && { email: read.email, confirmed: read.confirmed && o.homeAccount };
    return await recordSignIn(admin, { did: o.did, handle: o.handle, name: profile?.displayName ?? null, email });
  } catch (err) {
    console.error("[techne] recording the person failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export { NEWS_NOTE_COOKIE } from "./newsNote";
