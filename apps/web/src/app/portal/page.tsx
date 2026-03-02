import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { Key, Ticket, User } from "lucide-react";

export default async function PortalPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: member } = await supabase
    .from("members")
    .select("*")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) {
    return (
      <div className="glass-panel p-8 text-center max-w-md mx-auto mt-16">
        <h2 className="text-xl font-semibold mb-3">Membership Pending</h2>
        <p className="text-muted text-sm">
          You&apos;re in the system — your account just needs to be set up by an admin.
          <br /><br />
          Reach out on Telegram if you haven&apos;t heard back yet.
        </p>
        <p className="text-xs text-muted mt-4">{user.email}</p>
      </div>
    );
  }

  const isFullMember = member.member_type === "full";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-forest">Welcome back, {member.name.split(" ")[0]}</h1>
        <p className="text-muted mt-1 capitalize">{member.membership_tier.replace("_", " ")} Member</p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {isFullMember && (
          <Link href="/portal/my-code">
            <Card className="glass-panel hover-lift cursor-pointer">
              <CardContent className="p-6">
                <Key className="w-8 h-8 text-sage mb-3" />
                <h3 className="font-semibold mb-1">My Door Code</h3>
                <p className="text-sm text-muted">View or change your permanent door code</p>
                {member.pin_code && (
                  <p className="text-xl font-mono font-bold text-gold mt-3">{member.pin_code}</p>
                )}
              </CardContent>
            </Card>
          </Link>
        )}

        <Link href="/portal/passes">
          <Card className="glass-panel hover-lift cursor-pointer">
            <CardContent className="p-6">
              <Ticket className="w-8 h-8 text-sage mb-3" />
              <h3 className="font-semibold mb-1">Day Passes</h3>
              <p className="text-sm text-muted">
                {isFullMember ? "Generate guest day pass codes" : "Request a door code for today"}
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/portal/profile">
          <Card className="glass-panel hover-lift cursor-pointer">
            <CardContent className="p-6">
              <User className="w-8 h-8 text-sage mb-3" />
              <h3 className="font-semibold mb-1">Profile</h3>
              <p className="text-sm text-muted">Update your bio, skills, and contact info</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
