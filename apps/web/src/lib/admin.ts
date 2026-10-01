import { createClient } from "@/lib/supabase/server";

/**
 * Verify the current session belongs to an active admin member.
 * Returns the Supabase user if admin, null otherwise.
 *
 * `disabled` is checked here as well as `is_admin`: disabling a member is how
 * access is taken away, and it has to take the admin surface with it.
 */
export async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("members")
    .select("is_admin, disabled")
    .eq("supabase_user_id", user.id)
    .single();

  return data?.is_admin && !data.disabled ? user : null;
}
