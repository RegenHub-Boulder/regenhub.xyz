import { createClient } from "@/lib/supabase/server";

/**
 * Verify the current session belongs to an admin member.
 * Returns the Supabase user if admin, null otherwise.
 */
export async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("members")
    .select("is_admin")
    .eq("supabase_user_id", user.id)
    .single();

  return data?.is_admin ? user : null;
}
