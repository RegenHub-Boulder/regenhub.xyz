import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSelfServePlans } from "@/lib/stripe";
import { DAY_PASS_MEMBER_CENTS, DAY_PASS_PUBLIC_CENTS, MEMBERSHIP_FROM_CENTS, PLANS, formatCents } from "@/lib/plans";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SubscribeButton } from "@/components/membership/SubscribeButton";
import { CryptoSubscribeButton } from "@/components/membership/CryptoSubscribeButton";
import { Check, Sparkles, ArrowRight } from "lucide-react";
import { MemberOffer } from "@/components/membership/MemberOffer";
import { isSyntheticEmail } from "@/lib/regenos/syntheticEmail";

export const metadata: Metadata = {
  title: "Membership — RegenHub",
  description:
    `Membership at RegenHub, from ${formatCents(MEMBERSHIP_FROM_CENTS)} a month: member demos, Studio Night, coworking days and the member rate on day passes.`,
};

// Perks shown on every social tier card (the offer itself is <MemberOffer>, above the plans)
const SOCIAL_PERKS = [
  "Member demos and Studio Night",
  `Day passes at the member rate (${formatCents(DAY_PASS_MEMBER_CENTS)} instead of ${formatCents(DAY_PASS_PUBLIC_CENTS)})`,
  "Unused days carry over; they never expire",
];

// Perks shown on every desk tier card
const DESK_PERKS = [
  "Permanent door code, 24/7 access",
  "Member demos and Studio Night",
  `Guest day passes at the member rate (${formatCents(DAY_PASS_MEMBER_CENTS)})`,
];

// The three ways in, in the order a stranger meets them.
const LADDER = [
  {
    step: 1,
    title: "Free day",
    price: "Free",
    body: "Come work for a day on us. No card, no commitment — pick a date and we'll send you a door code. One per person.",
  },
  {
    step: 2,
    title: "Day pass",
    price: `${formatCents(DAY_PASS_PUBLIC_CENTS)} / day`,
    body: `Liked it? Drop in whenever, Monday to Friday, no contract. Members pay ${formatCents(DAY_PASS_MEMBER_CENTS)} and bank unused passes.`,
  },
  {
    step: 3,
    title: "Membership",
    price: `from ${formatCents(MEMBERSHIP_FROM_CENTS)} / month`,
    body: "The member nights and demos, plus coworking days each month. Desk plans add a permanent door code and 24/7 access.",
  },
] as const;

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
  let subscriptionEmail = user?.email && !isSyntheticEmail(user.email) ? user.email : undefined;
  if (user) {
    const { data: existingMember } = await supabase
      .from("members")
      .select("id, email, approved_for_daily, approved_for_full")
      .eq("supabase_user_id", user.id)
      .maybeSingle();
    approvedForDaily = existingMember?.approved_for_daily ?? false;
    approvedForFull = existingMember?.approved_for_full ?? false;
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
  const showNotApprovedBanner = user !== null && approvedForDaily === false && !hasActiveSub;
  // Anonymous visitors used to get five live "Pay by card" buttons that ended
  // in a 403 from /api/membership/subscribe with the raw error on screen.
  // Nobody can buy a membership before we've approved them, so anyone who
  // isn't approved sees the ladder in words instead of a checkout grid.
  const showLadderInsteadOfCheckout = user === null || showNotApprovedBanner;
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
    <div className="px-6 py-12">
      <div className="max-w-5xl mx-auto space-y-12">
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

        {wasCancelled && (
          <div className="glass-panel p-4 border border-rule text-center">
            <p className="text-sm text-muted">Checkout cancelled — no charge made. Come back any time.</p>
          </div>
        )}

        {hasActiveSub && (
          <div className="glass-panel panel-tone p-5 border border-sage/30 max-w-2xl mx-auto text-center space-y-3">
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
          <div className="glass-panel panel-tone p-5 border border-warn/40 max-w-2xl mx-auto text-center space-y-3">
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
          <div className="glass-panel panel-tone p-5 border border-gold/30 max-w-2xl mx-auto text-center space-y-3">
            <p className="font-medium">Full Access needs one more step</p>
            <p className="text-sm text-muted">
              You&apos;re cleared for the member plans below. Full Access
              ({formatCents(PLANS.hot_desk.defaultMonthlyCents)} Hot Desk / {formatCents(PLANS.cold_desk.defaultMonthlyCents)} Cold Desk) involves 24/7 access + a permanent door
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

        {/* The ladder, in plain words — what a stranger actually needs to know. */}
        {showLadderInsteadOfCheckout && (
          <section className="space-y-5">
            <h2 className="text-2xl font-semibold text-forest text-center">How to join</h2>
            <div className="grid md:grid-cols-3 gap-5">
              {LADDER.map(({ step, title, price, body }) => (
                <Card key={title} className="glass-panel">
                  <CardContent className="p-6 space-y-2">
                    <p className="text-xs text-sage">Step {step}</p>
                    <h2 className="text-xl font-semibold text-forest">{title}</h2>
                    <p className="text-2xl font-bold text-gold">{price}</p>
                    <p className="text-sm text-muted leading-relaxed">{body}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            {!user && (
              <div className="glass-panel p-6 max-w-2xl mx-auto text-center space-y-3">
                <p className="font-medium">Apply first</p>
                <p className="text-sm text-muted">
                  We welcome each member personally, so joining starts with an application rather
                  than a checkout page. Tell us about you and we&apos;ll be in touch — or come try
                  a free day before you decide anything.
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
          </section>
        )}

        {/* Contributing tiers ($30 / $50 / $100) */}
        {!hasActiveSub && !showLadderInsteadOfCheckout && (
          <section className="space-y-5">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-forest">Plans</h2>
              <p className="text-sm text-muted mt-1">Every plan includes everything above. They differ in coworking days.</p>
            </div>
            <div className="grid md:grid-cols-3 gap-5">
              {socialPlans.map(({ key, def }) => {
                const isFeatured = key === "member_2day";
                const dollars = def.defaultMonthlyCents / 100;
                return (
                  <Card
                    key={key}
                    className={`glass-panel relative ${isFeatured ? "panel-tone border border-sage/40" : ""}`}
                  >
                    {isFeatured && (
                      <span
                        className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-xs font-semibold px-3 py-0.5 rounded-full"
                        style={{ background: "var(--sage)", color: "var(--forest-deep)" }}
                      >
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
                      <p className="text-sm text-muted">{def.description}</p>
                      <div className="border-t border-rule pt-4 space-y-2 flex-1">
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
                      <div className="space-y-2">
                        <SubscribeButton
                          planKey={key}
                          isAuthenticated={!!user}
                          authedEmail={subscriptionEmail}
                          cta={isFeatured ? "Pay by card — most popular" : "Pay by card"}
                          className={isFeatured ? "btn-primary-glass w-full" : "btn-glass w-full"}
                        />
                        {user && <CryptoSubscribeButton planKey={key} />}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        )}

        {/* Full Access tiers ($250 / $500) */}
        {!hasActiveSub && !showLadderInsteadOfCheckout && deskPlans.length > 0 && (
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
                      <p className="text-sm text-muted">{def.description}</p>
                      <div className="border-t border-rule pt-4 space-y-2 flex-1">
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
                      {showDeskGate ? (
                        <Link href="/apply" className="block">
                          <Button className="btn-glass w-full">Request Full Access →</Button>
                        </Link>
                      ) : (
                        <div className="space-y-2">
                          <SubscribeButton
                            planKey={key}
                            isAuthenticated={!!user}
                            authedEmail={subscriptionEmail}
                            cta={`Pay by card — ${def.label}`}
                            className="btn-primary-glass w-full"
                          />
                          {user && <CryptoSubscribeButton planKey={key} />}
                        </div>
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

        {/* Promo code hint — only meaningful once there's a checkout button to click */}
        {!showLadderInsteadOfCheckout && (
          <div className="glass-panel p-4 max-w-2xl mx-auto text-center">
            <p className="text-sm text-muted">
              Have a promotion code (cohort discount, trial, etc.)? Paste it on the Stripe checkout page after clicking Subscribe.
            </p>
          </div>
        )}

        {/* Footer link */}
        <p className="text-center text-xs text-muted">
          Already a member? <Link href="/portal" className="text-sage hover:underline">Sign in to your portal →</Link>
        </p>
      </div>
    </div>
  );
}
