import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { canApproveOnSite } from "@/lib/approval";

/**
 * Verify the current session belongs to an active admin member.
 * Returns the Supabase user and the admin's own member row (id + name, for
 * audit trails and "approved by"), or null.
 *
 * `disabled` is checked here as well as `is_admin`: disabling a member is how
 * access is taken away, and it has to take the admin surface with it. Every
 * admin route goes through this (or `requireAdmin` below) — don't re-check
 * `is_admin` by hand; adminGuard.test.ts enforces it.
 */
export async function requireAdminMember() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("members")
    .select("*")
    .eq("supabase_user_id", user.id)
    .single();

  if (!data?.is_admin || data.disabled) return null;
  // canApprove: a co-op member, who may turn desk access on and set a desk's custom price (lib/approval.ts).
  return { user, member: { id: data.id, name: data.name, isOpsAdmin: !!data.is_ops_admin, canApprove: canApproveOnSite(data) } };
}

/**
 * The People → Applications / Free days pages and their routes (T-482, migration 074): a site admin (sees them) or a
 * co-op member (approves; lib/approval.ts canApproveOnSite), not disabled. `canApprove` is whether this person may
 * vouch, approve or turn down; a site admin who isn't a co-op member sees the lists without the buttons.
 */
export async function requireApprovalsViewer() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("members").select("*").eq("supabase_user_id", user.id).single();
  if (!data || data.disabled) return null;
  const isAdmin = !!data.is_admin;
  const canApprove = canApproveOnSite(data);
  if (!isAdmin && !canApprove) return null;
  return { user, member: { id: data.id as number, name: data.name as string, isAdmin, canApprove } };
}

/** `requireAdminMember` for routes that only need the yes/no. */
export async function requireAdmin() {
  return (await requireAdminMember())?.user ?? null;
}

/** Who is signed in to the portal, whether they are an enabled admin and whether they approve, read once per request (React `cache`): the
 *  admin frame (which links to show) and the staff pages' gate (app/admin/(staff)/layout.tsx) share it. */
export const portalViewer = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, isAdmin: false, canApprove: false };
  const { data } = await supabase
    .from("members")
    .select("is_admin, is_coop_member, disabled")
    .eq("supabase_user_id", user.id)
    .maybeSingle();
  // A disabled member is not an admin, whatever their is_admin flag says. canApprove: a co-op member, who reaches
  // People → Applications and Free days to approve (lib/approval.ts canApproveOnSite).
  return { user, isAdmin: !!data?.is_admin && !data.disabled, canApprove: canApproveOnSite(data) };
});
