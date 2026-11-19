import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

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
    .select("id, name, is_admin, disabled")
    .eq("supabase_user_id", user.id)
    .single();

  if (!data?.is_admin || data.disabled) return null;
  return { user, member: { id: data.id, name: data.name } };
}

/** `requireAdminMember` for routes that only need the yes/no. */
export async function requireAdmin() {
  return (await requireAdminMember())?.user ?? null;
}

/** Who is signed in to the portal and whether they are an enabled admin, read once per request (React `cache`): the
 *  admin frame (which links to show) and the staff pages' gate (app/admin/(staff)/layout.tsx) share it. */
export const portalViewer = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, isAdmin: false };
  const { data } = await supabase
    .from("members")
    .select("is_admin, disabled")
    .eq("supabase_user_id", user.id)
    .maybeSingle();
  // A disabled member is not an admin, whatever their is_admin flag says.
  return { user, isAdmin: !!data?.is_admin && !data.disabled };
});
