import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ApplyForm from "./ApplyForm";

export default async function ApplyPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    // If they already have a member row, send them straight to the portal
    const { data: member } = await supabase
      .from("members")
      .select("id")
      .eq("supabase_user_id", user.id)
      .single();

    if (member) redirect("/portal");

    // If they already submitted an application, send them to see their status
    const { data: application } = await supabase
      .from("applications")
      .select("id")
      .eq("supabase_user_id", user.id)
      .single();

    if (application) redirect("/portal");

    // Authenticated but no application yet — show form with locked email
    return <ApplyForm authenticatedEmail={user.email} />;
  }

  // Not authenticated — show full public form
  return <ApplyForm />;
}
