import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSelfServePlans, PLANS } from "@/lib/stripe";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SubscribeButton } from "@/components/membership/SubscribeButton";
import { Check, Sparkles, ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "Membership — RegenHub",
  description:
    "Join the cooperative as a contributing member. Three tiers from $20/mo, monthly day passes, and member events.",
};

const PERKS = [
  "Member-only events (at least one per month)",
  "Day passes at the member rate ($20 instead of $25)",
  "Connection to the regenerative cooperative community",
  "Discounts on workshops + retreats (coming soon)",
];

interface PageProps {
  searchParams: Promise<{ cancelled?: string }>;
}

export default async function MembershipPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const params = await searchParams;
  const wasCancelled = params.cancelled === "1";

  // Pre-check: signed-in user with an existing subscription gets redirected to /portal info instead
  let hasActiveSub = false;
  if (user) {
    const { data: existing } = await supabase
      .from("subscriptions")
      .select("id")
      .in("status", ["active", "trialing", "past_due", "incomplete"])
      .limit(1)
      .maybeSingle();
    hasActiveSub = !!existing;
  }

  const plans = getSelfServePlans();
  const deskPlans = (Object.entries(PLANS) as Array<[keyof typeof PLANS, (typeof PLANS)[keyof typeof PLANS]]>)
    .filter(([, def]) => !def.selfServe);

  return (
    <div className="min-h-screen px-6 py-12">
      <div className="max-w-5xl mx-auto space-y-12">
        <header className="text-center space-y-3">
          <p className="text-sm text-sage uppercase tracking-wider flex items-center justify-center gap-2">
            <Sparkles className="w-4 h-4" />
            RegenHub Membership
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold text-forest">Become a Contributing Member</h1>
          <p className="text-muted max-w-2xl mx-auto">
            Support the cooperative, get member pricing on day passes, and step into a community building economic democracy in Boulder.
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

        {/* Self-serve plans */}
        {!hasActiveSub && (
          <div className="grid md:grid-cols-3 gap-5">
            {plans.map(({ key, def }, idx) => {
              const isFeatured = key === "member_2day";
              const dollars = def.defaultMonthlyCents / 100;
              const passNote = def.monthlyDayPasses
                ? `${def.monthlyDayPasses} day pass${def.monthlyDayPasses === 1 ? "" : "es"} credited monthly`
                : "Buy day passes at the member rate";
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
                      <p className="text-xs text-muted uppercase tracking-wider mb-1">Tier {idx + 1}</p>
                      <h3 className="text-xl font-semibold text-forest">{def.label}</h3>
                      <div className="flex items-baseline gap-1 mt-2">
                        <span className="text-4xl font-bold text-gold">${dollars}</span>
                        <span className="text-sm text-muted">/month</span>
                      </div>
                    </div>
                    <p className="text-sm text-foreground/80">{def.description}</p>
                    <div className="border-t border-white/10 pt-4 space-y-2 flex-1">
                      {PERKS.map((p) => (
                        <div key={p} className="flex items-start gap-2 text-sm">
                          <Check className="w-4 h-4 text-sage shrink-0 mt-0.5" />
                          <span className="text-muted">{p}</span>
                        </div>
                      ))}
                      {def.monthlyDayPasses ? (
                        <div className="flex items-start gap-2 text-sm">
                          <Check className="w-4 h-4 text-sage shrink-0 mt-0.5" />
                          <span className="text-foreground font-medium">{passNote}</span>
                        </div>
                      ) : null}
                    </div>
                    <SubscribeButton
                      planKey={key}
                      isAuthenticated={!!user}
                      authedEmail={user?.email}
                      cta={isFeatured ? "Subscribe — most popular" : "Subscribe"}
                      className={isFeatured ? "btn-primary-glass w-full" : "btn-glass w-full"}
                    />
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Promo code hint */}
        <div className="glass-panel p-4 max-w-2xl mx-auto text-center">
          <p className="text-sm text-muted">
            Have a promotion code (cohort discount, trial, etc.)? Paste it on the Stripe checkout page after clicking Subscribe.
          </p>
        </div>

        {/* Desk membership note */}
        <div className="border-t border-white/10 pt-10 space-y-5">
          <h2 className="text-2xl font-semibold text-center text-forest">Looking for a desk?</h2>
          <p className="text-sm text-muted text-center max-w-2xl mx-auto">
            Desk memberships include a permanent door code and 24/7 access. Because the building has limited desks, these go through a quick application + conversation rather than instant checkout.
          </p>
          <div className="grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
            {deskPlans.map(([key, def]) => (
              <Card key={key} className="glass-panel">
                <CardContent className="p-5 space-y-2">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-semibold">{def.label}</h3>
                    <span className="text-sm text-muted">${def.defaultMonthlyCents / 100}/mo</span>
                  </div>
                  <p className="text-xs text-muted">{def.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="text-center">
            <Link href="/freeday">
              <Button className="btn-glass gap-2">
                Start with a free day visit <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </div>

        {/* Footer link */}
        <p className="text-center text-xs text-muted">
          Already a member? <Link href="/portal" className="text-sage hover:underline">Sign in to your portal →</Link>
        </p>
      </div>
    </div>
  );
}
