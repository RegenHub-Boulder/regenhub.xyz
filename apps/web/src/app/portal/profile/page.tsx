import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProfileForm } from "@/components/portal/ProfileForm";

export const metadata = { title: "Profile — RegenHub" };

export default async function ProfilePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: member } = await supabase
    .from("members")
    .select("id, name, email, telegram_username, ethereum_address, bio, skills, member_type")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) {
    return (
      <div className="glass-panel p-8 text-center max-w-md mx-auto mt-16">
        <h2 className="text-xl font-semibold mb-2">Account Not Found</h2>
        <p className="text-muted text-sm">
          Your login isn&apos;t linked to a member profile yet. Contact an admin to get set up.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold text-forest">Profile</h1>
        <p className="text-muted mt-1">Update your info in the member directory</p>
      </div>
      <ProfileForm member={member} />
    </div>
  );
}
