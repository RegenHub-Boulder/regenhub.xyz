import { createClient } from "@/lib/supabase/server";

export async function requirePortalMember() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: member } = await supabase
    .from("members")
    .select("id, name, email, disabled")
    .eq("supabase_user_id", user.id)
    .single();
  return member && !member.disabled ? { user, member } : null;
}
