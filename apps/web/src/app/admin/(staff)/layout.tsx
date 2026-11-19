import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { loginUrlFor } from "@/lib/safeNext";
import { createClient } from "@/lib/supabase/server";

/**
 * The portal admin pages (members, billing, access…): RegenHub admins only (`members.is_admin`, not disabled).
 * /admin/stewards sits outside this group: its authority is the Techne role, not this flag.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect(loginUrlFor((await headers()).get("x-pathname")));

  const { data: member } = await supabase
    .from("members")
    .select("is_admin, disabled")
    .eq("supabase_user_id", user.id)
    .single();

  // A disabled member is not an admin, whatever their is_admin flag says.
  if (!member?.is_admin || member.disabled) redirect("/portal");

  return <>{children}</>;
}
