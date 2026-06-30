import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, Clock, CreditCard, HandHeart, ArrowRight, MessageCircle, Sparkles } from "lucide-react";
import type { ApplicationStatus } from "@/lib/supabase/types";

type AppStatus = ApplicationStatus | null | undefined;

interface Props {
  memberType: string; // cold_desk | hot_desk | hub_friend | day_pass
  approvedForDaily: boolean;
  applicationStatus?: AppStatus;
  applicationInterest?: string | null;
  /** True when the member already has an active/paying subscription. */
  hasActiveSubscription: boolean;
}

function prettyInterest(v?: string | null): string | null {
  if (!v) return null;
  return v.replace(/_/g, " ");
}

/**
 * One clear answer to "where am I with membership, and what's my next step?"
 *
 * The portal previously scattered this: an active sub showed a manage card, a
 * day-pass member saw an "Apply to join" card at the bottom — even if they'd
 * already applied and were pending — and there was no signal for "you're
 * approved, go pick a plan." This consolidates the pre-membership funnel states
 * into a single card. Active subscribers are handled by the existing
 * subscription-management card, so this renders nothing for them.
 */
export function MembershipStatusCard({
  memberType,
  approvedForDaily,
  applicationStatus,
  applicationInterest,
  hasActiveSubscription,
}: Props) {
  // Active paying members: the subscription-management card already shows their
  // plan + status, so don't duplicate.
  if (hasActiveSubscription) return null;

  // Desk member without billing set up (pre-Stripe). Move them onto Stripe.
  if (memberType === "cold_desk" || memberType === "hot_desk") {
    const label = memberType === "cold_desk" ? "Cold Desk" : "Hot Desk";
    return (
      <Card className="glass-panel border border-gold/30 bg-gold/[0.03]">
        <CardContent className="p-6 flex items-start gap-4">
          <CreditCard className="w-7 h-7 text-gold shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold mb-1">You&apos;re a {label} member — finish billing setup</h3>
            <p className="text-sm text-muted mb-3">
              Your membership is active, but billing hasn&apos;t moved to automatic monthly payments yet.
              Pick your tier to set it up — one click and you&apos;re on the new system.
            </p>
            <Link href="/membership">
              <Button className="btn-primary-glass gap-2 text-sm">Set up billing <ArrowRight className="w-4 h-4" /></Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Hub Friend — a comped member. Positive status, gentle path to more.
  if (memberType === "hub_friend") {
    return (
      <Card className="glass-panel border border-sage/30 bg-sage/[0.04]">
        <CardContent className="p-6 flex items-start gap-4">
          <HandHeart className="w-7 h-7 text-sage shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold mb-1 flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-emerald-400" /> You&apos;re a Hub Friend
            </h3>
            <p className="text-sm text-muted mb-3">
              You&apos;ve got member access as a friend of the hub — member events, day passes at the member rate,
              and the community. Want a desk or to contribute on a tier? Explore the options anytime.
            </p>
            <Link href="/membership">
              <Button className="btn-glass gap-2 text-sm">Explore membership <ArrowRight className="w-4 h-4" /></Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---- day_pass (free / intro) members: show their funnel position ----

  // Approval supersedes an old application row: if they're cleared, point them at plans.
  if (approvedForDaily) {
    return (
      <Card className="glass-panel border border-emerald-500/30 bg-emerald-500/[0.04]">
        <CardContent className="p-6 flex items-start gap-4">
          <CheckCircle className="w-7 h-7 text-emerald-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold mb-1">You&apos;re approved to join — pick your plan</h3>
            <p className="text-sm text-muted mb-3">
              You&apos;re cleared to become a contributing member. Choose a tier to start your membership —
              it sets up automatic monthly billing and unlocks member events and day-pass pricing.
            </p>
            <Link href="/membership">
              <Button className="btn-primary-glass gap-2 text-sm">Choose a plan <ArrowRight className="w-4 h-4" /></Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (applicationStatus === "pending") {
    const interest = prettyInterest(applicationInterest);
    return (
      <Card className="glass-panel border border-amber-500/30 bg-amber-500/[0.03]">
        <CardContent className="p-6 flex items-start gap-4">
          <Clock className="w-7 h-7 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold mb-1">Your membership application is under review</h3>
            <p className="text-sm text-muted">
              Thanks for applying{interest ? <> for <span className="capitalize">{interest}</span></> : ""}!
              We approve members by hand so we can welcome each one personally — we&apos;ll be in touch soon.
              In the meantime, you can still use day passes and come to events.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (applicationStatus === "rejected") {
    return (
      <Card className="glass-panel border border-white/10">
        <CardContent className="p-6 flex items-start gap-4">
          <MessageCircle className="w-7 h-7 text-muted shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold mb-1">About your application</h3>
            <p className="text-sm text-muted">
              Your application wasn&apos;t approved this time. We&apos;d love to talk it through —
              reach out on Telegram or email <a href="mailto:boulder.regenhub@gmail.com" className="text-sage hover:underline">boulder.regenhub@gmail.com</a>.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // No application yet — the clear "become a member" call.
  return (
    <Card className="glass-panel border border-forest/20">
      <CardContent className="p-6 flex items-start gap-4">
        <Sparkles className="w-7 h-7 text-sage shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="font-semibold mb-1">Ready to become a member?</h3>
          <p className="text-sm text-muted mb-3">
            You&apos;re on day passes right now. Members get day passes at the member rate, member-only events,
            and a path to co-op ownership — with Full Access tiers ($250 Hot Desk / $500 Cold Desk) adding a
            permanent door code and 24/7 access. Apply to join and we&apos;ll get you set up.
          </p>
          <div className="flex gap-2 flex-wrap">
            <Link href="/apply">
              <Button className="btn-primary-glass gap-2 text-sm">Apply to join <ArrowRight className="w-4 h-4" /></Button>
            </Link>
            <Link href="/freeday">
              <Button className="btn-glass gap-2 text-sm">Try a free day first</Button>
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
