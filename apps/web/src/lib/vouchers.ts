import type { createServiceClient } from "@/lib/supabase/admin";
import { isMemberInStanding, PAYING_STATUSES } from "@/lib/memberStanding";
import { canApproveMembers } from "@/lib/approval";

type Service = ReturnType<typeof createServiceClient>;
type Row = { id: number; name: string; member_type: string | null; disabled: boolean | null; is_coop_member: boolean | null;
  is_admin: boolean | null; supabase_user_id: string | null; show_in_directory?: boolean | null };

const COLUMNS = "id, name, member_type, disabled, is_coop_member, is_admin, supabase_user_id, show_in_directory";

/**
 * Who may vouch for an application (T-482 round 5): the same set as migration 072's member_can_vouch, a member in
 * standing (lib/memberStanding.ts), a co-op owner or a site admin, never disabled. Used by the apply form's
 * "Who here knows you?" type-ahead and by the apply route, so an applicant can only name someone who can vouch.
 */
async function keepVouchers(admin: Service, rows: Row[]): Promise<Row[]> {
  const live = rows.filter((m) => !m.disabled);
  if (live.length === 0) return [];
  const { data: subs } = await admin.from("subscriptions").select("member_id, status, monthly_cents")
    .in("member_id", live.map((m) => m.id)).in("status", PAYING_STATUSES);
  return live.filter((m) => m.is_coop_member || canApproveMembers(m)
    || isMemberInStanding(m, (subs ?? []).filter((s) => s.member_id === m.id)));
}

/**
 * The name the type-ahead shows: the full name for a member listed in the directory (they chose to be public), else
 * first name and last initial ("Carey M."), so the type-ahead can't be used to read the whole roster.
 */
export function voucherName(m: { name: string; show_in_directory?: boolean | null }): string {
  if (m.show_in_directory) return m.name;
  const parts = m.name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

/** Up to 6 members who may vouch whose name contains `q` (2+ letters), never the person asking. */
export async function searchVouchers(admin: Service, q: string, notUserId: string): Promise<{ id: number; name: string }[]> {
  const { data, error } = await admin.from("members").select(COLUMNS)
    .ilike("name", `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    .eq("disabled", false).order("name").limit(30);
  if (error) throw new Error(error.message);
  const found = await keepVouchers(admin, ((data ?? []) as Row[]).filter((m) => m.supabase_user_id !== notUserId));
  return found.slice(0, 6).map((m) => ({ id: m.id, name: voucherName(m) }));
}

/** The member an applicant named, if they may vouch and aren't the applicant; null otherwise. */
export async function namedVoucher(admin: Service, id: number, notUserId: string): Promise<{ id: number; name: string } | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const { data } = await admin.from("members").select(COLUMNS).eq("id", id).maybeSingle();
  const row = data as Row | null;
  if (!row || row.supabase_user_id === notUserId) return null;
  const [ok] = await keepVouchers(admin, [row]);
  return ok ? { id: ok.id, name: ok.name } : null;
}
