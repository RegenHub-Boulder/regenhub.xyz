import { lockWriterFetch } from "@regenhub/shared";
import { createClient } from "@supabase/supabase-js";
import { telegramIlikePatterns } from "./telegram.js";
import { decideIdentity } from "../identity.js";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

// Service role client — bypasses RLS (bot has full access)
export const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false }, global: { fetch: lockWriterFetch } }
);

export type MemberRow = {
  id: number;
  name: string;
  email: string | null;
  telegram_username: string | null;
  /** Numeric Telegram id, bound on first verified interaction (migration 061). */
  telegram_user_id?: number | string | null;
  pin_code: string | null;
  pin_code_slot: number | null;
  member_type: "cold_desk" | "hot_desk" | "hub_friend" | "day_pass";
  is_coop_member: boolean;
  is_admin: boolean;
  disabled: boolean;
  day_passes_balance: number;
  invite_code: string | null;
};

/**
 * Resolve a member by their Telegram handle.
 *
 * Disabled members are excluded by default: `disabled` is how access is taken
 * away, so to every self-service path (/mycode, /newcode, /daypass, /invite)
 * and to every admin check, a disabled member is simply not a member. Admin
 * tooling that operates *on* a member — /changetype, /coop — passes
 * `{ includeDisabled: true }` so it can still reach those rows.
 */
export async function findMemberByTelegram(
  username: string,
  opts: { includeDisabled?: boolean } = {},
): Promise<MemberRow | null> {
  const p = telegramIlikePatterns(username);
  if (!p) return null;
  let q = db
    .from("members")
    .select("*")
    .or(`telegram_username.ilike.${p.bare},telegram_username.ilike.${p.withAt}`);
  if (!opts.includeDisabled) q = q.eq("disabled", false);
  const { data } = await q.limit(1).maybeSingle();
  return data ?? null;
}

export async function findAdminByTelegram(username: string): Promise<MemberRow | null> {
  const member = await findMemberByTelegram(username);
  return member?.is_admin && !member.disabled ? member : null;
}

/**
 * Resolve the member behind a Telegram sender, by numeric id first.
 *
 * - A row already bound to `from.id` wins, even if the @handle changed.
 * - Otherwise match by @username; an unbound row is bound to `from.id` now
 *   (trust on first use), a row bound to a DIFFERENT id is refused — that is a
 *   recycled handle — and is logged.
 * - If migration 061 isn't applied (no telegram_user_id column) this degrades
 *   to the old username-only behaviour.
 *
 * Use for every "who is the sender" check. Admin tooling that looks up a
 * *target* member by typed handle keeps using findMemberByTelegram.
 */
export async function resolveSender(
  from: { id?: number; username?: string } | undefined,
  opts: { includeDisabled?: boolean } = {},
): Promise<MemberRow | null> {
  const username = from?.username ?? "";
  const senderId = from?.id;

  if (senderId !== undefined) {
    let q = db.from("members").select("*").eq("telegram_user_id", senderId);
    if (!opts.includeDisabled) q = q.eq("disabled", false);
    const { data, error } = await q.limit(1).maybeSingle();
    if (!error && data) return data;
  }

  const row = await findMemberByTelegram(username, opts);
  if (!row) return null;
  // Column absent (migration not applied yet): legacy behaviour.
  if (!("telegram_user_id" in row)) return row;

  const decision = decideIdentity(row, senderId);
  if (decision.action === "accept") return row;
  if (decision.action === "refuse") {
    console.warn(`[Bot] Refused Telegram sender ${senderId ?? "?"} (@${username}) for member ${row.id}: ${decision.reason}`);
    return null;
  }
  // bind — conditional on still being NULL so two racing senders can't both win
  const { data: bound } = await db
    .from("members")
    .update({ telegram_user_id: senderId })
    .eq("id", row.id)
    .is("telegram_user_id", null)
    .select("id")
    .maybeSingle();
  if (!bound) {
    // Lost a race or the unique index rejected it (id already bound to another row).
    console.warn(`[Bot] Could not bind Telegram id ${senderId} to member ${row.id}; refusing`);
    return null;
  }
  console.log(`[Bot] Bound Telegram id ${senderId} to member ${row.id}`);
  return { ...row, telegram_user_id: senderId };
}

export async function resolveAdminSender(from: { id?: number; username?: string } | undefined): Promise<MemberRow | null> {
  const member = await resolveSender(from);
  return member?.is_admin && !member.disabled ? member : null;
}
