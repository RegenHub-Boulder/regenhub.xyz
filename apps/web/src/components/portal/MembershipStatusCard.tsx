import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, Clock, CreditCard, HandHeart, ArrowRight, MessageCircle, Sparkles } from "lucide-react";
import type { ApplicationStatus } from "@/lib/supabase/types";
import { DayPlanPicker } from "@/components/portal/DayPlanPicker";

type AppStatus = ApplicationStatus | null | undefined;

interface Props {
  memberType: string; // cold_desk | hot_desk | hub_friend | day_pass
  /** The one approval (lib/approval.ts): they may pick any day plan. */
  approved: boolean;
  /** Desk access: they may pick a desk. */
  deskAccess: boolean;
  applicationStatus?: AppStatus;
  /** A member has vouched on their application (072). */
  vouched?: boolean;
  /** True when the member already has an active/paying subscription. */
  hasActiveSubscription: boolean;
  /** Their sign-in email, for the card checkout. */
  email?: string;
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
  approved,
  deskAccess,
  applicationStatus,
  vouched,
  hasActiveSubscription,
  email,
}: Props) {
  // Active paying members: the subscription-management card already shows their
  // plan + status, so don't duplicate.
  if (hasActiveSubscription) return null;

  // Desk member without billing set up (pre-Stripe). Move them onto Stripe.
  if (memberType === "cold_desk" || memberType === "hot_desk") {
    const label = memberType === "cold_desk" ? "Cold Desk" : "Hot Desk";
    return (
      <Card className="glass-panel border border-gold/30">
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
      <Card className="glass-panel border border-sage/30">
        <CardContent className="p-6 flex items-start gap-4">
          <HandHeart className="w-7 h-7 text-sage shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold mb-1 flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-ok" /> You&apos;re a Hub Friend
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

  // Approved: pick a day plan right here (T-482 round 5), by card or USDC. Desk access too: the desks as well.
  if (approved) {
    return (
      <Card className="glass-panel border border-ok/40" data-testid="pick-plan">
        <CardContent className="p-6 space-y-4">
          <div className="flex items-start gap-3">
            <CheckCircle className="w-6 h-6 text-ok shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold mb-1">You&apos;re in. Pick your plan</h3>
              <p className="text-sm text-muted">
                Every plan has the member demos and Studio Night; they differ in coworking days. Days you don&apos;t use carry over.
              </p>
            </div>
          </div>
          <DayPlanPicker email={email} />
          {deskAccess ? (
            <>
              <p className="text-sm font-medium pt-2">Your desk access is on</p>
              <DayPlanPicker email={email} desks />
            </>
          ) : (
            <p className="text-xs text-muted">Want a desk later? Once you&apos;re on a plan you can ask about one here.</p>
          )}
        </CardContent>
      </Card>
    );
  }

  if (applicationStatus === "pending") {
    return (
      <Card className="glass-panel border border-warn/40 bg-warn/10">
        <CardContent className="p-6 flex items-start gap-4">
          <Clock className="w-7 h-7 text-warn shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold mb-1">Your application is in</h3>
            <p className="text-sm text-muted" data-testid="application-waiting">
              {vouched
                ? "A member has vouched for you. We approve next, within a day."
                : "Next, one member who knows you vouches. Haven't met us yet? Come to a night or a free day."}{" "}
              Then you pick a day plan here.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (applicationStatus === "rejected") {
    return (
      <Card className="glass-panel border border-rule">
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
            You&apos;re on day passes right now. Members get Studio Night and the Friday member demos, coworking
            days each month and day passes at the member rate. Applying takes a minute: a member vouches, a steward
            approves, then you pick a plan.
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
