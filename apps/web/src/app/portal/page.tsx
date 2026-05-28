import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { Key, Ticket, User, ClipboardList, CheckCircle, Clock, MessageCircle, Zap, Calendar, ArrowRight, AlertCircle, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import HubEssentials from "@/components/portal/HubEssentials";
import InviteCard from "@/components/portal/InviteCard";
import { ManageSubscriptionButton } from "@/components/portal/ManageSubscriptionButton";
import { ChangePlanButton } from "@/components/portal/ChangePlanButton";
import { OnboardingChecklist } from "@/components/portal/OnboardingChecklist";
import { planLabel, getPlan } from "@/lib/plans";

export default async function PortalPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const [memberResult, applicationResult] = await Promise.all([
    supabase.from("members").select("*").eq("supabase_user_id", user.id).single(),
    supabase.from("applications").select("*").eq("supabase_user_id", user.id).single(),
  ]);
  let member = memberResult.data;
  const application = applicationResult.data;

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

  // Look up the original interest signup (if any) for the funnel-continuity ack
  let interestSignup: { created_at: string } | null = null;
  if (member) {
    const { data } = await supabase
      .from("interests")
      .select("created_at")
      .eq("member_id", member.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    interestSignup = data;
  }

  // Look up active subscription (if any) for the manage-subscription CTA
  let activeSubscription:
    | {
        plan_key: string;
        monthly_cents: number;
        status: string;
        cancel_at_period_end: boolean;
        current_period_end: string | null;
        past_due_since: string | null;
        discount_cents: number | null;
      }
    | null = null;
  if (member) {
    const { data } = await supabase
      .from("subscriptions")
      .select("plan_key, monthly_cents, status, cancel_at_period_end, current_period_end, past_due_since, discount_cents")
      .eq("member_id", member.id)
      .in("status", ["active", "trialing", "past_due"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    activeSubscription = data;
  }

  // Whether the member can swap plans via the in-portal change-plan flow.
  // Source of truth is lib/plans.ts (selfServe flag). Members ON a desk tier
  // are blocked at the route level since leaving a desk needs admin code revocation.
  const currentPlanDef = activeSubscription ? getPlan(activeSubscription.plan_key) : null;
  const onDesk =
    currentPlanDef?.grantsMemberType === "cold_desk" ||
    currentPlanDef?.grantsMemberType === "hot_desk";
  const canChangePlan = !!activeSubscription && (currentPlanDef?.selfServe ?? false) && !onDesk;

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
  // eslint-disable-next-line react-hooks/purity -- server component, renders once
  const accountAgeMs = Date.now() - new Date(member.created_at).getTime();
  const isNewMember = !member.pin_code || accountAgeMs < 7 * 24 * 60 * 60 * 1000;

  const interestSignupLabel = interestSignup
    ? new Date(interestSignup.created_at).toLocaleDateString("en-US", {
        timeZone: "America/Denver",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div className="space-y-8">
      {/* Top-priority banner: payment failed needs attention */}
      {activeSubscription?.status === "past_due" && (
        <div className="glass-panel p-4 border border-red-500/40 bg-red-500/5 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-400">Your payment failed</p>
            <p className="text-xs text-muted mt-0.5">
              Update your card to keep your access. We&apos;ll automatically retry — and door access continues for 7 days while you sort it out.
            </p>
          </div>
          <ManageSubscriptionButton />
        </div>
      )}

      <div>
        <h1 className="text-3xl font-bold text-forest">Welcome back, {member.name.split(" ")[0]}</h1>
        <p className="text-muted mt-1">{typeLabel} Member</p>
        {interestSignupLabel && (
          <p className="text-xs text-muted mt-2">
            Thanks for joining our list on {interestSignupLabel}. Glad you stuck with us.
          </p>
        )}
      </div>

      {isNewMember && (
        <OnboardingChecklist
          needsPinCode={isFullMember}
          hasPinCode={!!member.pin_code}
          hasPhoto={!!member.profile_photo_url}
          hasBio={!!member.bio}
          hasTelegram={!!member.telegram_username}
        />
      )}

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

      {/* Subscription management — shown for ANY active sub (desk or social tiers) */}
      {activeSubscription && (
        <Card className="glass-panel border border-sage/20">
          <CardContent className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h3 className="font-semibold mb-1">
                  Membership
                  {activeSubscription.plan_key && (
                    <span className="text-muted font-normal ml-2 text-sm">
                      · {planLabel(activeSubscription.plan_key)} · ${activeSubscription.monthly_cents / 100}/mo
                    </span>
                  )}
                </h3>
                {activeSubscription.cancel_at_period_end && activeSubscription.current_period_end && (
                  <p className="text-sm text-amber-400 flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4" />
                    Cancelling on{" "}
                    {new Date(activeSubscription.current_period_end).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                )}
                {activeSubscription.status === "past_due" && (
                  <p className="text-sm text-red-400 flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4" />
                    Payment failed — update your card to keep access
                  </p>
                )}
                {!activeSubscription.cancel_at_period_end && activeSubscription.status !== "past_due" && (
                  <p className="text-sm text-muted">
                    Renews{" "}
                    {activeSubscription.current_period_end
                      ? new Date(activeSubscription.current_period_end).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })
                      : "monthly"}
                  </p>
                )}
              </div>
              <div className="flex gap-2 flex-wrap">
                {canChangePlan && (
                  <ChangePlanButton
                    currentPlanKey={activeSubscription.plan_key}
                    currentMonthlyCents={activeSubscription.monthly_cents}
                    hasDiscount={(activeSubscription.discount_cents ?? 0) > 0}
                  />
                )}
                <ManageSubscriptionButton />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Existing desk members who pre-date Stripe — now self-serve. */}
      {(member.member_type === "cold_desk" || member.member_type === "hot_desk") &&
        !activeSubscription && (
          <Card className="glass-panel border border-gold/30 bg-gold/[0.03]">
            <CardContent className="p-6">
              <div className="flex items-start gap-4">
                <CreditCard className="w-7 h-7 text-gold shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h3 className="font-semibold mb-1">Set up automatic billing</h3>
                  <p className="text-sm text-muted mb-3">
                    You&apos;re a {typeLabel} member, but we haven&apos;t moved your billing to Stripe yet.
                    Pick your tier on the membership page to set up automatic monthly billing —
                    one click and you&apos;re on the new system.
                  </p>
                  <Link href="/membership">
                    <Button className="btn-primary-glass gap-2 text-sm">
                      Choose a plan
                      <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

      {/* Upgrade prompt only for day_pass members WITHOUT an active sub
          (free/intro users — paying social members shouldn't see "apply") */}
      {!isFullMember && !activeSubscription && (
        <Card className="glass-panel border border-forest/20">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <Key className="w-7 h-7 text-sage shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold mb-1">Ready for a permanent desk?</h3>
                <p className="text-sm text-muted mb-3">
                  Members get a permanent door code, 24/7 access, and a path to co-op ownership.
                  Hot Desk is $250/month, Cold Desk (reserved) is $500/month.
                </p>
                <Link href="/freeday">
                  <Button className="btn-glass gap-2 text-sm">
                    Apply for membership
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <HubEssentials defaultExpanded={isNewMember} />
    </div>
  );
}
