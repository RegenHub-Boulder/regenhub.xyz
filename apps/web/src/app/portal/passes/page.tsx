import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe, isStripeConfigured, PASS_KINDS } from "@/lib/stripe";
import { fulfillPassPurchase } from "@/lib/passFulfillment";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RequestDayPassButton } from "@/components/portal/RequestDayPassButton";
import { RevokeCodeButton } from "@/components/portal/RevokeCodeButton";
import { BuyPassButton } from "@/components/portal/BuyPassButton";
import { Ticket, Clock, ShoppingCart, Key, ArrowRight, CheckCircle, XCircle, Receipt, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export const metadata = { title: "Live Codes — RegenHub" };

interface PageProps {
  searchParams: Promise<{ session_id?: string; checkout?: string }>;
}

export default async function PassesPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: member } = await supabase
    .from("members")
    .select("id, name, email, member_type, day_passes_balance")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) {
    return (
      <div className="glass-panel p-8 text-center max-w-md mx-auto mt-16">
        <Ticket className="w-8 h-8 text-muted mx-auto mb-3" />
        <h2 className="text-xl font-semibold mb-2">Account Not Found</h2>
        <p className="text-muted text-sm">
          Your login isn&apos;t linked to a member profile yet. Contact an admin to get set up.
        </p>
      </div>
    );
  }

  // Post-checkout fulfillment: if Stripe redirected with a session_id, look
  // up the session and idempotently fulfill it. This makes the balance feel
  // instant even before the webhook arrives. UNIQUE on stripe_checkout_session
  // means a double-call (page + webhook) is safe.
  const params = await searchParams;
  let justPurchased: { label: string; passes: number } | null = null;
  let purchaseError: string | null = null;
  let liveBalance = member.day_passes_balance;

  if (params.session_id && isStripeConfigured()) {
    try {
      const session = await getStripe().checkout.sessions.retrieve(params.session_id);
      const result = await fulfillPassPurchase(session, createServiceClient());
      if (result.status === "granted" || result.status === "already_processed") {
        const kind = session.metadata?.kind as keyof typeof PASS_KINDS | undefined;
        const def = kind ? PASS_KINDS[kind] : null;
        if (def) {
          justPurchased = { label: def.label, passes: result.passes_granted ?? def.quantity };
        }
        if (typeof result.new_balance === "number") {
          liveBalance = result.new_balance;
        } else if (result.status === "granted") {
          // Re-read the balance to reflect the freshly-granted passes
          const { data: fresh } = await supabase
            .from("members")
            .select("day_passes_balance")
            .eq("id", member.id)
            .single();
          if (fresh) liveBalance = fresh.day_passes_balance;
        }
      } else if (result.reason) {
        purchaseError = `Checkout completed but fulfillment skipped: ${result.reason}`;
      }
    } catch (err) {
      console.error("[PassesPage] Fulfillment lookup failed:", err);
      purchaseError = "We couldn't verify your purchase. If your balance doesn't update in a minute, contact an admin.";
    }
  }

  const isFullMember = member.member_type !== "day_pass";

  const [{ data: activeCodes }, { data: recentPurchases }, { data: recentGrants }, { data: activeSub }] = await Promise.all([
    supabase
      .from("day_codes")
      .select("*")
      .eq("member_id", member.id)
      .eq("is_active", true)
      .order("expires_at", { ascending: true, nullsFirst: false }),
    supabase
      .from("purchases")
      .select("id, kind, amount_cents, passes_granted, created_at")
      .eq("member_id", member.id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("pass_grants")
      .select("id, plan_key, passes_granted, created_at")
      .eq("member_id", member.id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("subscriptions")
      .select("id")
      .eq("member_id", member.id)
      .in("status", ["active", "trialing"])
      .limit(1)
      .maybeSingle(),
  ]);

  // Contributing-member rate ($25 vs $30 on single passes) — keep this in
  // sync with the same check in /api/portal/buy-passes.
  const isContributingMember = !!activeSub;

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold text-forest">
          {isFullMember ? "Guest Day Passes" : "Day Passes"}
        </h1>
        <p className="text-muted mt-1">
          {isFullMember
            ? "Generate temporary door codes for guests"
            : "Get a door code for the day (8 AM – 6 PM, Mon–Fri)"}
        </p>
      </div>

      {/* Post-checkout banner */}
      {justPurchased && (
        <div className="glass-panel p-4 border border-emerald-500/30 bg-emerald-500/5 flex items-start gap-3">
          <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-emerald-400">
              Purchase complete — {justPurchased.passes} pass{justPurchased.passes === 1 ? "" : "es"} added to your balance.
            </p>
            <p className="text-xs text-muted mt-0.5">Thanks for supporting RegenHub.</p>
          </div>
        </div>
      )}
      {params.checkout === "cancelled" && !justPurchased && (
        <div className="glass-panel p-4 border border-white/10 flex items-start gap-3">
          <XCircle className="w-5 h-5 text-muted shrink-0 mt-0.5" />
          <p className="text-sm text-muted">Checkout cancelled — no charge made.</p>
        </div>
      )}
      {purchaseError && (
        <div className="glass-panel p-4 border border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-amber-400">{purchaseError}</p>
        </div>
      )}

      {/* Balance + action */}
      <Card className="glass-panel">
        <CardContent className="p-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 text-sm text-muted mb-1">
                <Ticket className="w-4 h-4" />
                {isFullMember ? "Guest passes available" : "Passes remaining"}
              </div>
              <p className={`text-4xl font-bold ${liveBalance > 0 ? "text-gold" : "text-muted"}`}>
                {liveBalance}
              </p>
            </div>
            <RequestDayPassButton
              memberId={member.id}
              isFullMember={isFullMember}
              remainingUses={liveBalance}
            />
          </div>
          {liveBalance === 0 && !isFullMember && (
            <p className="text-sm text-muted mt-4">
              No passes remaining — grab one below to get a door code.
            </p>
          )}
          {liveBalance === 0 && isFullMember && (
            <p className="text-sm text-muted mt-4">
              No guest passes — buy below to share day codes with visitors.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Active codes */}
      {activeCodes && activeCodes.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">Active codes</h2>
          <div className="space-y-3">
            {activeCodes.map((code) => {
              const expiresAt = code.expires_at ? new Date(code.expires_at) : null;
              const msLeft = expiresAt ? expiresAt.getTime() - Date.now() : null;
              const hoursLeft = msLeft != null ? Math.max(0, Math.ceil(msLeft / 3600000)) : null;
              const timeLabel = hoursLeft == null
                ? null
                : hoursLeft < 24 ? `${hoursLeft}h left` : `${Math.ceil(hoursLeft / 24)}d left`;

              return (
                <div key={code.id} className="glass-panel p-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-mono font-bold text-gold text-xl">{code.code}</p>
                    {code.label && <p className="text-xs text-muted mt-0.5">{code.label}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-sm text-muted">
                      <Clock className="w-4 h-4" />
                      {timeLabel != null ? (
                        <>
                          <span>{timeLabel}</span>
                          <Badge variant="outline" className="text-xs border-white/20">
                            {expiresAt!.toLocaleDateString("en-US", {
                              month: "short", day: "numeric",
                              timeZone: "America/Denver",
                            })}
                          </Badge>
                        </>
                      ) : (
                        <span>No expiry</span>
                      )}
                    </div>
                    <RevokeCodeButton codeId={code.id} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(!activeCodes || activeCodes.length === 0) && (
        <div className="glass-panel p-8 text-center text-muted">
          <Ticket className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p>No active codes. Generate one above.</p>
        </div>
      )}

      {/* Buy more passes — always shown; Stripe configuration is checked server-side */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <ShoppingCart className="w-5 h-5 text-sage" />
          {isFullMember ? "Buy guest passes" : "Get a day pass"}
        </h2>
        <div className="max-w-sm">
          <BuyPassButton
            kind="day_pass"
            className="glass-panel p-5 hover:bg-white/5 transition-colors group block text-left w-full"
          >
            <p className="font-semibold mb-1">Single Day Pass</p>
            {isContributingMember ? (
              <div className="mb-3 flex items-baseline gap-2">
                <p className="text-3xl font-bold text-gold">$25</p>
                <p className="text-sm text-muted line-through">$30</p>
                <span className="text-xs bg-sage/20 text-sage px-2 py-0.5 rounded-full">member rate</span>
              </div>
            ) : (
              <p className="text-3xl font-bold text-gold mb-3">$30</p>
            )}
            <p className="text-xs text-muted group-hover:text-foreground transition-colors">
              1 door code &rarr; full day access &rarr;
            </p>
          </BuyPassButton>
        </div>
      </div>

      {/* Recent activity — purchases + monthly auto-grants */}
      {((recentPurchases && recentPurchases.length > 0) || (recentGrants && recentGrants.length > 0)) && (
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Receipt className="w-5 h-5 text-sage" />
            Recent activity
          </h2>
          <div className="glass-panel divide-y divide-white/5">
            {/* Merge + sort by date desc */}
            {[
              ...(recentPurchases ?? []).map((p) => ({
                key: `p-${p.id}`,
                date: p.created_at,
                icon: <ShoppingCart className="w-4 h-4 text-sage" />,
                title: p.kind === "five_pack" ? "5-Pack purchased (legacy)" : "Day Pass purchased",
                amount: `$${p.amount_cents / 100}`,
                detail: `+${p.passes_granted} pass${p.passes_granted === 1 ? "" : "es"}`,
              })),
              ...(recentGrants ?? []).map((g) => ({
                key: `g-${g.id}`,
                date: g.created_at,
                icon: <Gift className="w-4 h-4 text-sage" />,
                title: "Monthly passes credited",
                amount: "",
                detail: `+${g.passes_granted} pass${g.passes_granted === 1 ? "" : "es"}`,
              })),
            ]
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
              .slice(0, 15)
              .map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {row.icon}
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{row.title}</p>
                      <p className="text-xs text-muted">{row.detail}</p>
                    </div>
                  </div>
                  <div className="text-right text-xs shrink-0">
                    {row.amount && <p className="font-medium">{row.amount}</p>}
                    <p className="text-muted">
                      {new Date(row.date).toLocaleDateString("en-US", {
                        timeZone: "America/Denver",
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Contributing-member nudge — only for non-subscribed users */}
      {!isFullMember && !isContributingMember && (
        <Card className="glass-panel border border-sage/30">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <Ticket className="w-7 h-7 text-sage shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-semibold mb-1">Become an Interim Member</h3>
                <p className="text-sm text-muted mb-4">
                  $30/month includes 1 coworking day per month (passes never expire), member rate on additional day passes ($25 vs $30), and members-only events.
                </p>
                <Link href="/membership">
                  <Button className="btn-primary-glass gap-2 text-sm">
                    See membership tiers
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Membership upgrade prompt for day_pass members */}
      {!isFullMember && (
        <Card className="glass-panel border border-forest/20">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <Key className="w-7 h-7 text-sage shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-semibold mb-1">Ready for your own desk?</h3>
                <p className="text-sm text-muted mb-4">
                  Desk members get a permanent door code, 24/7 access, and a path to co-op ownership.
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
    </div>
  );
}
