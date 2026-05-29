import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSelfServePlans } from "@/lib/stripe";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SubscribeButton } from "@/components/membership/SubscribeButton";
import { Check, Sparkles, ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "Membership — RegenHub",
  description:
    "Join the cooperative as a contributing member. Five tiers from $30/mo, including desk membership with 24/7 access.",
};

// Perks shown on every social tier card
const SOCIAL_PERKS = [
  "Day passes at the member rate ($25 instead of $30)",
  "Monthly day passes accumulate — they never expire",
  "Member-only events (at least one per month)",
  "Connection to the regenerative cooperative community",
];

// Perks shown on every desk tier card
const DESK_PERKS = [
  "Permanent door code, 24/7 access",
  "Member-only events (at least one per month)",
  "Guest day passes at the member rate ($25)",
  "Path to co-op ownership",
];

interface PageProps {
  searchParams: Promise<{ cancelled?: string }>;
}

export default async function MembershipPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const params = await searchParams;
  const wasCancelled = params.cancelled === "1";

  // Pre-check: signed-in user state determines what CTAs to show.
  // IMPORTANT: filter the subscription lookup by member_id explicitly.
  // RLS's admin policy returns ALL subscriptions, so an unfiltered query
  // would falsely report "you already have a membership" when an admin
  // visits this page without their own subscription.
  let hasActiveSub = false;
  let approvedForDaily: boolean | null = null; // null = unauthed; UI shows generic CTA
  let approvedForFull = false;
  if (user) {
    const { data: existingMember } = await supabase
      .from("members")
      .select("id, approved_for_daily, approved_for_full")
      .eq("supabase_user_id", user.id)
      .maybeSingle();
    approvedForDaily = existingMember?.approved_for_daily ?? false;
    approvedForFull = existingMember?.approved_for_full ?? false;
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
  const showNotApprovedBanner = user !== null && approvedForDaily === false && !hasActiveSub;
  // Show desk-not-approved card only when they ARE approved for membership
  // but not yet for desks — otherwise the generic not-approved banner covers it.
  const showDeskGate = user !== null && approvedForDaily === true && !approvedForFull && !hasActiveSub;

  // Split self-serve plans into social ladder + desk tiers for separate layouts.
  const allSelfServe = getSelfServePlans();
  const socialPlans = allSelfServe.filter(
    ({ def }) => def.grantsMemberType !== "cold_desk" && def.grantsMemberType !== "hot_desk",
  );
  const deskPlans = allSelfServe.filter(
    ({ def }) => def.grantsMemberType === "cold_desk" || def.grantsMemberType === "hot_desk",
  );

  return (
    <div className="min-h-screen px-6 py-12">
      <div className="max-w-5xl mx-auto space-y-12">
        <header className="text-center space-y-3">
          <p className="text-sm text-sage uppercase tracking-wider flex items-center justify-center gap-2">
            <Sparkles className="w-4 h-4" />
            RegenHub Membership
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold text-forest">Pick your tier</h1>
          <p className="text-muted max-w-2xl mx-auto">
            Step into a cooperative building economic democracy in Boulder. Contributing tiers
            ($30–$100/mo) support the space and unlock member events. Full Access ($250–$500/mo)
            adds a permanent door code and 24/7 access.
          </p>
        </header>

        {wasCancelled && (
          <div className="glass-panel p-4 border border-white/10 text-center">
            <p className="text-sm text-muted">Checkout cancelled — no charge made. Come back any time.</p>
          </div>
        )}

        {hasActiveSub && (
          <div className="glass-panel p-5 border border-sage/30 max-w-2xl mx-auto text-center space-y-3">
            <p className="font-medium">You already have an active membership.</p>
            <p className="text-sm text-muted">Manage your subscription, switch plans, or update your card in the portal.</p>
            <Link href="/portal">
              <Button className="btn-primary-glass gap-2">
                Go to portal <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        )}

        {showNotApprovedBanner && (
          <div className="glass-panel p-5 border border-amber-500/30 max-w-2xl mx-auto text-center space-y-3">
            <p className="font-medium">Apply to join first</p>
            <p className="text-sm text-muted">
              We approve membership signups manually so we can welcome each member personally.
              Apply directly, or try a free day visit first.
            </p>
            <div className="flex gap-3 justify-center flex-wrap">
              <Link href="/apply">
                <Button className="btn-primary-glass gap-2">
                  Apply to join <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <Link href="/freeday">
                <Button className="btn-glass">Try a free day first</Button>
              </Link>
            </div>
          </div>
        )}

        {showDeskGate && (
          <div className="glass-panel p-5 border border-gold/30 max-w-2xl mx-auto text-center space-y-3">
            <p className="font-medium">Full Access needs one more step</p>
            <p className="text-sm text-muted">
              You&apos;re cleared for the Contributing Member tiers below. Full Access
              ($250 Hot Desk / $500 Cold Desk) involves 24/7 access + a permanent door
              code, so we set up a quick chat first — reach out and we&apos;ll get you welcomed in.
            </p>
            <div className="flex gap-3 justify-center flex-wrap">
              <Link href="/apply">
                <Button className="btn-primary-glass gap-2">
                  Request Full Access <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <a href="mailto:boulder.regenhub@gmail.com?subject=Full%20Access%20membership">
                <Button className="btn-glass">Email us</Button>
              </a>
            </div>
          </div>
        )}

        {/* Contributing tiers ($30 / $50 / $100) */}
        {!hasActiveSub && (
          <section className="space-y-5">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-forest">Contributing Member</h2>
              <p className="text-sm text-muted mt-1">Support the cooperative + accumulate day passes</p>
            </div>
            <div className="grid md:grid-cols-3 gap-5">
              {socialPlans.map(({ key, def }) => {
                const isFeatured = key === "member_2day";
                const dollars = def.defaultMonthlyCents / 100;
                return (
                  <Card
                    key={key}
                    className={`glass-panel relative ${isFeatured ? "border border-sage/40" : ""}`}
                  >
                    {isFeatured && (
                      <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-sage text-forest text-xs font-semibold px-3 py-0.5 rounded-full">
                        Most popular
                      </span>
                    )}
                    <CardContent className="p-6 space-y-5 flex flex-col h-full">
                      <div>
                        <h3 className="text-xl font-semibold text-forest">{def.label}</h3>
                        <div className="flex items-baseline gap-1 mt-2">
                          <span className="text-4xl font-bold text-gold">${dollars}</span>
                          <span className="text-sm text-muted">/month</span>
                        </div>
                      </div>
                      <p className="text-sm text-foreground/80">{def.description}</p>
                      <div className="border-t border-white/10 pt-4 space-y-2 flex-1">
                        {def.monthlyDayPasses ? (
                          <div className="flex items-start gap-2 text-sm">
                            <Check className="w-4 h-4 text-sage shrink-0 mt-0.5" />
                            <span className="text-foreground font-medium">
                              {def.monthlyDayPasses} day pass{def.monthlyDayPasses === 1 ? "" : "es"} credited monthly
                            </span>
                          </div>
                        ) : null}
                        {SOCIAL_PERKS.map((p) => (
                          <div key={p} className="flex items-start gap-2 text-sm">
                            <Check className="w-4 h-4 text-sage shrink-0 mt-0.5" />
                            <span className="text-muted">{p}</span>
                          </div>
                        ))}
                      </div>
                      {showNotApprovedBanner ? (
                        <Link href="/apply" className="block">
                          <Button className={isFeatured ? "btn-primary-glass w-full" : "btn-glass w-full"}>
                            Apply to join →
                          </Button>
                        </Link>
                      ) : (
                        <SubscribeButton
                          planKey={key}
                          isAuthenticated={!!user}
                          authedEmail={user?.email}
                          cta={isFeatured ? "Subscribe — most popular" : "Subscribe"}
                          className={isFeatured ? "btn-primary-glass w-full" : "btn-glass w-full"}
                        />
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        )}

        {/* Full Access tiers ($250 / $500) */}
        {!hasActiveSub && deskPlans.length > 0 && (
          <section className="space-y-5 pt-4">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-forest">Full Access</h2>
              <p className="text-sm text-muted mt-1">Permanent door code + 24/7 access — limited availability</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-5 max-w-3xl mx-auto">
              {deskPlans.map(({ key, def }) => {
                const dollars = def.defaultMonthlyCents / 100;
                const isCold = def.grantsMemberType === "cold_desk";
                return (
                  <Card key={key} className="glass-panel border border-forest/30">
                    <CardContent className="p-6 space-y-5 flex flex-col h-full">
                      <div>
                        <h3 className="text-xl font-semibold text-forest">{def.label}</h3>
                        <div className="flex items-baseline gap-1 mt-2">
                          <span className="text-4xl font-bold text-gold">${dollars}</span>
                          <span className="text-sm text-muted">/month</span>
                        </div>
                      </div>
                      <p className="text-sm text-foreground/80">{def.description}</p>
                      <div className="border-t border-white/10 pt-4 space-y-2 flex-1">
                        <div className="flex items-start gap-2 text-sm">
                          <Check className="w-4 h-4 text-sage shrink-0 mt-0.5" />
                          <span className="text-foreground font-medium">
                            {isCold ? "Your own reserved desk" : "Any open desk"}
                          </span>
                        </div>
                        {DESK_PERKS.map((p) => (
                          <div key={p} className="flex items-start gap-2 text-sm">
                            <Check className="w-4 h-4 text-sage shrink-0 mt-0.5" />
                            <span className="text-muted">{p}</span>
                          </div>
                        ))}
                      </div>
                      {showNotApprovedBanner ? (
                        <Link href="/apply" className="block">
                          <Button className="btn-glass w-full">Apply to join →</Button>
                        </Link>
                      ) : showDeskGate ? (
                        <Link href="/apply" className="block">
                          <Button className="btn-glass w-full">Request Full Access →</Button>
                        </Link>
                      ) : (
                        <SubscribeButton
                          planKey={key}
                          isAuthenticated={!!user}
                          authedEmail={user?.email}
                          cta={`Subscribe — ${def.label}`}
                          className="btn-primary-glass w-full"
                        />
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            <p className="text-xs text-muted text-center max-w-xl mx-auto">
              Your permanent PIN gets auto-allocated on subscription. Cold Desks are first-come, first-served — reach out if you want to chat about timing or sliding-scale rates.
            </p>
          </section>
        )}

        {/* Promo code hint */}
        <div className="glass-panel p-4 max-w-2xl mx-auto text-center">
          <p className="text-sm text-muted">
            Have a promotion code (cohort discount, trial, etc.)? Paste it on the Stripe checkout page after clicking Subscribe.
          </p>
        </div>

        {/* Footer link */}
        <p className="text-center text-xs text-muted">
          Already a member? <Link href="/portal" className="text-sage hover:underline">Sign in to your portal →</Link>
        </p>
      </div>
    </div>
  );
}
