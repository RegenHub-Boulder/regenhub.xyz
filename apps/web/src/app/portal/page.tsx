import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { Key, Ticket, User, ClipboardList, CheckCircle, Clock, MessageCircle, Zap, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import HubEssentials from "@/components/portal/HubEssentials";
import InviteCard from "@/components/portal/InviteCard";

export default async function PortalPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  let [{ data: member }, { data: application }] = await Promise.all([
    supabase.from("members").select("*").eq("supabase_user_id", user.id).single(),
    supabase.from("applications").select("*").eq("supabase_user_id", user.id).single(),
  ]);

  // Auto-link: if no member found by supabase_user_id, try matching by verified email.
  // This handles the case where a member was created via Telegram bot (no supabase_user_id)
  // and then signs in on the web with the same email.
  if (!member && user.email) {
    const admin = createServiceClient();
    const { data: matched } = await admin
      .from("members")
      .select("*")
      .eq("email", user.email)
      .is("supabase_user_id", null)
      .single();

    if (matched) {
      // Link this member to the authenticated user
      await admin
        .from("members")
        .update({ supabase_user_id: user.id })
        .eq("id", matched.id);
      member = { ...matched, supabase_user_id: user.id };
    }
  }

  // Look up free day claim for this user (used for day_pass members auto-created from free day)
  // Uses service client since free_day_claims isn't in the typed RLS schema
  let freeDayClaim: { id: number; claimed_date: string; status: string } | null = null;
  if (member?.member_type === "day_pass") {
    const admin = createServiceClient();
    const { data } = await admin
      .from("free_day_claims")
      .select("id, claimed_date, status")
      .eq("supabase_user_id", user.id)
      .in("status", ["pending", "reserved", "activated"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    freeDayClaim = data;
  }

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
          <p className="text-xs text-muted">Interested in: <span className="capitalize">{application.membership_interest.replace(/_/g, " ")}</span></p>
        </div>
      );
    }

    return (
      <div className="space-y-6 max-w-md mx-auto mt-16">
        <div className="glass-panel p-8 text-center">
          <ClipboardList className="w-10 h-10 text-sage mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-3">Complete Your Application</h2>
          <p className="text-muted text-sm mb-6">
            You&apos;re signed in as <strong className="text-foreground">{user.email}</strong>.<br />
            Fill out a short application so we can get you set up.
          </p>
          <Link href="/freeday">
            <Button className="btn-primary-glass px-6">Get Your Free Day</Button>
          </Link>
        </div>

        <div className="glass-panel p-6">
          <div className="flex items-start gap-3">
            <MessageCircle className="w-5 h-5 text-sage mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium mb-1">Already a member via Telegram?</p>
              <p className="text-xs text-muted leading-relaxed">
                If you have an existing account through our Telegram bot, send{" "}
                <code className="bg-white/10 px-1.5 py-0.5 rounded text-foreground">/email {user.email}</code>{" "}
                to the bot to link your account. Then refresh this page.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isFullMember = member.member_type !== "day_pass";
  const typeLabel = member.member_type === "cold_desk" ? "Cold Desk" : member.member_type === "hot_desk" ? "Hot Desk" : member.member_type === "hub_friend" ? "Hub Friend" : "Day Pass";

  // Show onboarding expanded for new members (no pin code set or account < 7 days old)
  const isNewMember = !member.pin_code ||
    (Date.now() - new Date(member.created_at).getTime() < 7 * 24 * 60 * 60 * 1000);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-forest">Welcome back, {member.name.split(" ")[0]}</h1>
        <p className="text-muted mt-1">{typeLabel} Member</p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {isFullMember && (
          <Link href="/portal/my-code">
            <Card className="glass-panel hover-lift cursor-pointer">
              <CardContent className="p-6">
                <Key className="w-8 h-8 text-sage mb-3" />
                <h3 className="font-semibold mb-1">My Door Code</h3>
                <p className="text-sm text-muted">View or change your permanent door code</p>
                {member.pin_code ? (
                  <p className="text-sm text-sage mt-3">Code active</p>
                ) : (
                  <p className="text-sm text-amber-400 mt-3">No code set</p>
                )}
              </CardContent>
            </Card>
          </Link>
        )}

        {freeDayClaim && !isFullMember && (
          <Link href="/freeday">
            <Card className="glass-panel hover-lift cursor-pointer border border-gold/20">
              <CardContent className="p-6">
                {freeDayClaim.status === "activated" ? (
                  <>
                    <Zap className="w-8 h-8 text-gold mb-3" />
                    <h3 className="font-semibold mb-1">Free Day Active</h3>
                    <p className="text-sm text-muted">View your door code</p>
                  </>
                ) : freeDayClaim.status === "reserved" ? (
                  <>
                    <Calendar className="w-8 h-8 text-gold mb-3" />
                    <h3 className="font-semibold mb-1">Free Day Reserved</h3>
                    <p className="text-sm text-muted">
                      {freeDayClaim.claimed_date === new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date())
                        ? "Today! Tap to get your door code"
                        : `Reserved for ${new Date(freeDayClaim.claimed_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                    </p>
                  </>
                ) : (
                  <>
                    <Clock className="w-8 h-8 text-sage mb-3" />
                    <h3 className="font-semibold mb-1">Application Pending</h3>
                    <p className="text-sm text-muted">Your free day is being reviewed</p>
                  </>
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
                {isFullMember ? "Generate guest day pass codes" : "Buy day passes for door access"}
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

        {member.is_coop_member && <InviteCard />}
      </div>

      <HubEssentials defaultExpanded={isNewMember} />
    </div>
  );
}
