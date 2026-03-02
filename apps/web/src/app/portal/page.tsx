import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { Key, Ticket, User, ClipboardList, CheckCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

export default async function PortalPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const [{ data: member }, { data: application }] = await Promise.all([
    supabase.from("members").select("*").eq("supabase_user_id", user.id).single(),
    supabase.from("applications").select("*").eq("supabase_user_id", user.id).single(),
  ]);

  if (!member) {
    if (application) {
      const statusColor = application.status === "approved"
        ? "text-green-400"
        : application.status === "rejected"
          ? "text-red-400"
          : "text-yellow-400";
      const StatusIcon = application.status === "approved" ? CheckCircle : Clock;
      return (
        <div className="glass-panel p-8 text-center max-w-md mx-auto mt-16">
          <StatusIcon className={`w-10 h-10 ${statusColor} mx-auto mb-4`} />
          <h2 className="text-xl font-semibold mb-2">Application {application.status === "pending" ? "Under Review" : application.status === "approved" ? "Approved" : "Not Approved"}</h2>
          <p className="text-muted text-sm mb-4">
            {application.status === "pending" && "We've received your application and will be in touch soon."}
            {application.status === "approved" && "Your application was approved! An admin is setting up your access."}
            {application.status === "rejected" && "Your application wasn't approved this time. Reach out on Telegram to learn more."}
          </p>
          <p className="text-xs text-muted mb-1">Submitted as: {application.email}</p>
          <p className="text-xs text-muted">Membership interest: <span className="capitalize">{application.membership_interest}</span></p>
        </div>
      );
    }

    return (
      <div className="glass-panel p-8 text-center max-w-md mx-auto mt-16">
        <ClipboardList className="w-10 h-10 text-sage mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-3">Complete Your Application</h2>
        <p className="text-muted text-sm mb-6">
          You&apos;re signed in as <strong className="text-foreground">{user.email}</strong>.<br />
          Fill out a short application so we can get you set up.
        </p>
        <Link href="/apply">
          <Button className="btn-primary-glass px-6">Start Application</Button>
        </Link>
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
