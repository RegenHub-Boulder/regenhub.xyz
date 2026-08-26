import { createClient } from "@/lib/supabase/server";

export async function requirePortalMember() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: member } = await supabase
    .from("members")
    .select("id, name, email")
    .eq("supabase_user_id", user.id)
    .single();
  return member ? { user, member } : null;
}
