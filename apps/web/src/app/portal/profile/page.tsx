import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProfileForm } from "@/components/portal/ProfileForm";
import { TechneAccountCard } from "@/components/techne/TechneAccountCard";
import { handleFor } from "@/lib/techne/did";
import { fetchTechneProfile } from "@/lib/techne/profile";
import { createServiceClient } from "@/lib/supabase/admin";
import { PAYING_STATUSES } from "@/lib/memberStanding";
import { isListed } from "@/lib/memberDirectory";
import { currentViewAs } from "@/lib/viewAsServer";
import { NotInPreview } from "@/components/portal/ViewAsBar";

export const metadata = { title: "Profile — RegenHub" };

export default async function ProfilePage() {
  // An admin's portal preview (lib/viewAs.ts) shows only the member home: this page would read (and here and there
  // act on) the admin's own account, so it stops before any of that.
  if (await currentViewAs()) return <NotInPreview />;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: member } = await supabase
    .from("members")
    .select("id, name, email, telegram_username, ethereum_address, bio, skills, profile_photo_url, member_type, did, working_on, links, show_in_directory, show_rsvps, disabled, is_coop_member")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) {
    return (
      <div className="glass-panel p-8 text-center max-w-md mx-auto mt-16">
        <h2 className="text-xl font-semibold mb-2">Account not found</h2>
        <p className="text-muted text-sm">
          Your login isn&apos;t linked to a member profile yet. Contact an admin to get set up.
        </p>
      </div>
    );
  }

  const { data: subs } = await createServiceClient()
    .from("subscriptions")
    .select("status, monthly_cents")
    .eq("member_id", member.id)
    .in("status", PAYING_STATUSES);
  const [handle, techne] = member.did
    ? await Promise.all([handleFor(member.did), fetchTechneProfile(member.did)])
    : [null, null];
  const canBeListed = isListed({ ...member, show_in_directory: true }, subs ?? []);
  const listed = isListed(member, subs ?? []);

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold text-forest">Profile</h1>
        <p className="text-muted mt-1">Your member page, and how we reach you</p>
      </div>
      <ProfileForm
        member={member}
        extras={{
          techneBio: techne?.bio ?? null,
          techneAvatarUrl: techne?.avatarUrl ?? null,
          canBeListed,
          pagePath: listed ? `/members/${encodeURIComponent(handle ?? String(member.id))}` : null,
        }}
      />
      {member.did && (
        <TechneAccountCard did={member.did} handle={handle} endpoint="/api/portal/techne/unlink" who="you" />
      )}
    </div>
  );
}
