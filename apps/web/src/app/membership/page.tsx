import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { MEMBERSHIP_LADDER, MEMBERSHIP_FROM_CENTS, formatCents } from "@/lib/plans";
import { Button } from "@/components/ui/button";
import { Sparkles, ArrowRight } from "lucide-react";
import { MemberOffer } from "@/components/membership/MemberOffer";
import { ladderLine } from "@/components/landing/HomeMembership";
import { DayPlanPicker } from "@/components/portal/DayPlanPicker";
import { isSyntheticEmail } from "@/lib/regenos/syntheticEmail";
import { approvalOf, type ApprovalRow } from "@/lib/approval";

export const metadata: Metadata = {
  title: "Membership — RegenHub",
  description:
    `Membership at RegenHub, from ${formatCents(MEMBERSHIP_FROM_CENTS)} a month: member demos, Studio Night, coworking days and the member rate on day passes.`,
};

/** How joining goes (T-482 round 5), in the order a stranger meets it. */
const STEPS = [
  { title: "Come by", body: "Come to a night (they're free and open to everyone) or take a free day." },
  { title: "Apply", body: "A minute: your name, what you work on, and who here knows you." },
  { title: "A member vouches, we approve", body: "One member who has met you vouches. We reply within a day." },
  { title: "Pick a day plan", body: "From your portal, by card or USDC. Desks are an upgrade once you're a member." },
] as const;

interface PageProps {
  searchParams: Promise<{ cancelled?: string }>;
}

export default async function MembershipPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const params = await searchParams;
  const wasCancelled = params.cancelled === "1";

  // Who is looking, and where they are: not signed in, waiting on an application, approved, or already on a plan.
  // The subscription lookup is filtered by member_id: RLS's admin policy would otherwise return everyone's.
  let hasActiveSub = false;
  let approved = false;
  let deskAccess = false;
  let applicationPending = false;
  let subscriptionEmail = user?.email && !isSyntheticEmail(user.email) ? user.email : undefined;
  if (user) {
    const [{ data: existingMember }, { data: application }] = await Promise.all([
      supabase.from("members").select("*").eq("supabase_user_id", user.id).maybeSingle(),
      supabase.from("applications").select("status").eq("supabase_user_id", user.id).maybeSingle(),
    ]);
    const approval = approvalOf(existingMember as ApprovalRow | null);
    approved = approval.member;
    deskAccess = approval.desk;
    applicationPending = application?.status === "pending";
    subscriptionEmail = existingMember?.email ?? subscriptionEmail;
    if (existingMember?.id) {
      const { data: existingSub } = await supabase
        .from("subscriptions")
        .select("id")
        .eq("member_id", existingMember.id)
        .in("status", ["active", "trialing", "past_due", "incomplete"])
        .limit(1)
        .maybeSingle();
      hasActiveSub = !!existingSub;
    }
  }

  return (
    <div className="px-6 py-12">
      <div className="max-w-3xl mx-auto space-y-12">
        <header className="text-center space-y-3">
          <p className="text-sm text-sage flex items-center justify-center gap-2">
            <Sparkles className="w-4 h-4" />
            RegenHub Membership
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold text-forest">A place in the practice</h1>
          <p className="text-muted max-w-2xl mx-auto">
            Techne Tuesdays stay free and open to everyone. Membership, from {formatCents(MEMBERSHIP_FROM_CENTS)} a month, gets you into the rooms
            where members show their work and help each other with it.
          </p>
        </header>

        <MemberOffer />

        {/* The one ladder, as on the home page: the day plans, then the desks. Prices from lib/plans.ts. */}
        <section className="space-y-3" data-testid="membership-ladder">
          <h2 className="text-2xl font-semibold text-forest">The plans</h2>
          <ul className="border-b border-rule">
            {MEMBERSHIP_LADDER.map((p) => (
              <li key={p.label} className="border-t border-rule py-3 grid grid-cols-[7.5rem_1fr] sm:grid-cols-[8.5rem_1fr] items-baseline gap-x-4">
                <span className="text-lg">
                  <span className="text-gold">{formatCents(p.defaultMonthlyCents)}</span>
                  <span className="text-muted"> a month</span>
                </span>
                <span>{ladderLine(p)}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">
            On the day plans, unused days carry over. The desks come with your own door code, any hour: they&apos;re an
            upgrade for members, after a talk with a steward.
          </p>
        </section>

        {wasCancelled && (
          <p className="text-sm text-muted text-center">Checkout cancelled: no charge made. Come back any time.</p>
        )}

        {hasActiveSub ? (
          <section className="text-center space-y-3">
            <p className="font-medium">You already have a membership.</p>
            <p className="text-sm text-muted">Change your plan, ask about a desk, or update your card from your portal.</p>
            <Link href="/portal"><Button className="btn-primary-glass gap-2">Go to your portal <ArrowRight className="w-4 h-4" /></Button></Link>
          </section>
        ) : approved ? (
          <section className="space-y-3" data-testid="membership-pick">
            <h2 className="text-2xl font-semibold text-forest">You&apos;re approved: pick your plan</h2>
            <DayPlanPicker email={subscriptionEmail} />
            {deskAccess && (
              <>
                <p className="text-sm font-medium pt-2">Your desk access is on</p>
                <DayPlanPicker email={subscriptionEmail} desks />
              </>
            )}
            <p className="text-xs text-muted">Have a promotion code? Paste it on the card checkout page.</p>
          </section>
        ) : (
          <section className="space-y-5" data-testid="membership-how">
            <h2 className="text-2xl font-semibold text-forest">How to join</h2>
            <ol className="space-y-3">
              {STEPS.map((step, i) => (
                <li key={step.title} className="grid grid-cols-[2rem_1fr] gap-x-2">
                  <span className="text-gold font-semibold">{i + 1}.</span>
                  <span><span className="font-medium">{step.title}.</span> <span className="text-muted">{step.body}</span></span>
                </li>
              ))}
            </ol>
            {applicationPending ? (
              <p className="text-sm text-muted">Your application is in. Your portal shows where it stands.</p>
            ) : (
              <div className="flex gap-3 flex-wrap items-center">
                <Link href="/apply"><Button className="btn-primary-glass gap-2">Apply to join <ArrowRight className="w-4 h-4" /></Button></Link>
                <Link href="/freeday" className="text-sage hover:underline">Your first day is free →</Link>
              </div>
            )}
          </section>
        )}

        <p className="text-center text-xs text-muted">
          Already a member? <Link href="/portal" className="text-sage hover:underline">Sign in to your portal →</Link>
        </p>
      </div>
    </div>
  );
}
