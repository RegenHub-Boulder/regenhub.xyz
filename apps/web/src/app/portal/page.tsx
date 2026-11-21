import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { Ticket, ClipboardList, CheckCircle, Clock, MessageCircle, Zap, Calendar, ArrowRight, AlertCircle, Wallet, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import HubEssentials from "@/components/portal/HubEssentials";
import InviteCard from "@/components/portal/InviteCard";
import { ManageSubscriptionButton } from "@/components/portal/ManageSubscriptionButton";
import { CancelPlanSwitchButton, ChangePlanButton } from "@/components/portal/ChangePlanButton";
import { OnboardingChecklist } from "@/components/portal/OnboardingChecklist";
import { DirectoryAsk } from "@/components/portal/DirectoryAsk";
import { PAYING_STATUSES } from "@/lib/memberStanding";
import { isListed } from "@/lib/memberDirectory";
import { RevealPin } from "@/components/portal/RevealPin";
import { startOfDayIn } from "@/lib/series";
import { DayPassRedemptionHero } from "@/components/portal/DayPassRedemptionHero";
import { MembershipStatusCard } from "@/components/portal/MembershipStatusCard";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { planLabel, getPlan } from "@/lib/plans";
import { memberTypeLabel } from "@/lib/memberTypeLabel";
import { isSyntheticEmail } from "@/lib/regenos/syntheticEmail";
import { OnchainBillingCard } from "@/components/portal/OnchainBillingCard";
import { RemoveWalletButton } from "@/components/portal/RemoveWalletButton";
import { isOnchainBillingConfigured, NATIVE_USDC_ADDRESS, TREASURY_ADDRESS } from "@/lib/onchain/config";

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
  if (!member && user.email && !isSyntheticEmail(user.email)) {
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
        id: number;
        payment_rail: "stripe" | "onchain";
        wallet_id: number | null;
        monthly_cents: number;
        net_cents: number | null;
        status: string;
        cancel_at_period_end: boolean;
        current_period_end: string | null;
        past_due_since: string | null;
        discount_cents: number | null;
        pending_plan_key?: string | null;
        pending_plan_at?: string | null;
        pending_plan_from?: string | null;
      }
    | null = null;
  if (member) {
    const { data } = await supabase
      .from("subscriptions")
      .select("id, payment_rail, wallet_id, plan_key, monthly_cents, net_cents, status, cancel_at_period_end, current_period_end, past_due_since, discount_cents, pending_plan_key, pending_plan_at, pending_plan_from")
      .eq("member_id", member.id)
      // `incomplete` is the first-payment state for a self-serve on-chain
      // membership. It must render the invoice/payment card even though no
      // access is granted until the transfer is credited.
      .in("status", ["active", "trialing", "past_due", "incomplete"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    activeSubscription = data;
  }

  // Ask once whether to be in the member directory (lib/memberDirectory.ts), of a member who could be listed.
  let askDirectory = false;
  if (member && member.show_in_directory == null && !member.disabled) {
    const { data: paying } = await supabase
      .from("subscriptions")
      .select("status, monthly_cents")
      .eq("member_id", member.id)
      .in("status", PAYING_STATUSES);
    askDirectory = isListed({ ...member, show_in_directory: true }, paying ?? []);
  }

  let onchainWallet: { address: string; verification_method: string } | null = null;
  let onchainInvoice: {
    id: number; amount_cents: number; amount_usdc_micros: number; due_at: string;
    status: string; submitted_tx_hash: string | null; coupon_code?: string | null; coupon_discount_cents?: number;
  } | null = null;
  if (activeSubscription?.payment_rail === "onchain") {
    const admin = createServiceClient();
    const [walletResult, invoiceResult] = await Promise.all([
      activeSubscription.wallet_id
        ? admin.from("member_wallets").select("address, verification_method").eq("id", activeSubscription.wallet_id).is("revoked_at", null).maybeSingle()
        : Promise.resolve({ data: null }),
      admin.from("onchain_invoices")
        .select("id, amount_cents, amount_usdc_micros, due_at, status, submitted_tx_hash, coupon_code, coupon_discount_cents")
        .eq("subscription_id", activeSubscription.id)
        .in("status", ["open", "submitted", "detected", "exception"])
        .order("due_at", { ascending: true }).limit(1).maybeSingle(),
    ]);
    onchainWallet = walletResult.data;
    onchainInvoice = invoiceResult.data;
  }

  // A wallet can stay linked with no crypto membership behind it (a canceled
  // membership, a card member, a test account). Show it so it can be removed.
  let idleWallet: { id: number; address: string } | null = null;
  if (member && activeSubscription?.payment_rail !== "onchain") {
    const { data } = await supabase
      .from("member_wallets")
      .select("id, address")
      .eq("member_id", member.id)
      .is("revoked_at", null)
      .maybeSingle();
    idleWallet = data;
  }

  // "In today" on the door panel: distinct members who unlocked since midnight at the hub (service client:
  // access_logs RLS hides other members from the signed-in one).
  const adminClient = createServiceClient();
  const { data: hereNowRows } = await adminClient
    .from("access_logs")
    .select("member_id")
    .eq("result", "granted")
    .gte("created_at", startOfDayIn("America/Denver").toISOString())
    .not("member_id", "is", null);
  const hereNowCount = new Set((hereNowRows ?? []).map((r) => r.member_id)).size;

  // Install-prompt eligibility: don't nag first-time visitors before they've
  // actually used the space once. Eligible iff they have a granted access_log
  // entry OR their account is at least a day old (a proxy: someone returning
  // after a long gap probably knows what they're doing).
  let installPromptEligible = false;
  if (member) {
    // eslint-disable-next-line react-hooks/purity -- server component, renders once per request
    const accountAgeMs2 = Date.now() - new Date(member.created_at).getTime();
    if (accountAgeMs2 > 24 * 60 * 60 * 1000) {
      installPromptEligible = true;
    } else {
      const { data: ownEntry } = await adminClient
        .from("access_logs")
        .select("id")
        .eq("member_id", member.id)
        .eq("result", "granted")
        .limit(1)
        .maybeSingle();
      installPromptEligible = !!ownEntry;
    }
  }

  // Whether the member can swap plans via the in-portal change-plan flow.
  // Source of truth is lib/plans.ts (selfServe flag). A desk member can move to a
  // daily plan; it takes effect when the paid period ends (lib/planSwitch.ts).
  const currentPlanDef = activeSubscription ? getPlan(activeSubscription.plan_key) : null;
  const pendingSwitch = activeSubscription?.pending_plan_key && activeSubscription.pending_plan_at
    ? {
      label: planLabel(activeSubscription.pending_plan_key),
      at: activeSubscription.pending_plan_at,
      // On chain plan_key already names the daily plan; the desk being kept is pending_plan_from.
      keeps: planLabel(activeSubscription.pending_plan_from ?? activeSubscription.plan_key),
    }
    : null;
  const canChangePlan = !!activeSubscription && activeSubscription.payment_rail === "stripe" &&
    (currentPlanDef?.selfServe ?? false) && !activeSubscription.cancel_at_period_end && !pendingSwitch;

  if (!member) {
    if (application) {
      const statusColor = application.status === "approved"
        ? "text-ok"
        : application.status === "rejected"
          ? "text-danger"
          : "text-warn";
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
          <h2 className="text-xl font-semibold mb-3">Welcome — let&apos;s get you set up</h2>
          <p className="text-muted text-sm mb-6">
            You&apos;re signed in{user.email && !isSyntheticEmail(user.email) ? (
              <> as <strong className="text-foreground">{user.email}</strong></>
            ) : null}, but you&apos;re
            not a member yet. Apply to join the cooperative, or try a free day first to feel out the space.
          </p>
          <div className="flex gap-2 flex-wrap justify-center">
            <Link href="/apply">
              <Button className="btn-primary-glass gap-2 px-6">
                Apply to join
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <Link href="/freeday">
              <Button className="btn-glass px-6">Try a free day</Button>
            </Link>
          </div>
        </div>

        {user.email && !isSyntheticEmail(user.email) && (
        <div className="glass-panel p-6">
          <div className="flex items-start gap-3">
            <MessageCircle className="w-5 h-5 text-sage mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium mb-1">Already a member via Telegram?</p>
              <p className="text-xs text-muted leading-relaxed">
                If you have an existing account through our Telegram bot, send{" "}
                <code className="bg-tint px-1.5 py-0.5 rounded text-foreground">/email {user.email}</code>{" "}
                to the bot to link your account. Then refresh this page.
              </p>
            </div>
          </div>
        </div>
        )}
      </div>
    );
  }

  const isFullMember = member.member_type !== "day_pass";
  const typeLabel = memberTypeLabel(member.member_type);

  // Show onboarding expanded for new members (no pin code set or account < 7 days old).
  // Day-pass folks see it too — the checklist is about orienting people to the
  // culture (photo helps the directory, Telegram is where the community lives,
  // bio helps members find common interests), not just about preparing them for
  // their first visit.
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

  // Hub Essentials (address, hours, Wi-Fi, keypad) opens by itself only on a newcomer's visit day: a free day booked
  // or activated for today in Boulder, or a day-pass code live right now (the same code the day-pass hero shows).
  // Every other day it starts closed, one click away, so the first-week page stays short.
  const todayInBoulder = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date());
  let visitingToday = !!freeDayClaim && ["reserved", "activated"].includes(freeDayClaim.status) &&
    freeDayClaim.claimed_date === todayInBoulder;
  if (isNewMember && !visitingToday && !isFullMember) {
    const { data: liveCode } = await adminClient
      .from("day_codes")
      .select("id")
      .eq("member_id", member.id)
      .eq("is_active", true)
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();
    visitingToday = !!liveCode;
  }

  const coopView = !!member.is_coop_member || !!member.is_admin;
  const passesLeft = member.day_passes_balance ?? 0;

  // The member home (T-482): what a member comes for, most often first. The door (their code, a guest code), then
  // anything that needs them (a payment, a next step, first-week setup), then their plan, then everything else.
  return (
    <div className="max-w-3xl space-y-8">
      {/* Top-priority banner: payment failed needs attention */}
      {activeSubscription?.status === "past_due" && (
        <div className="glass-panel p-4 border border-danger/40 bg-danger/10 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-danger">Your payment is past due</p>
            <p className="text-xs text-muted mt-0.5">
              {activeSubscription.payment_rail === "onchain"
                ? "Complete the USDC renewal below. Door access continues for seven days while you sort it out."
                : "Update your card to keep your access. We’ll automatically retry — and door access continues for seven days while you sort it out."}
            </p>
          </div>
          {activeSubscription.payment_rail === "stripe" && <ManageSubscriptionButton />}
        </div>
      )}

      <header>
        <h1 className="text-3xl font-bold text-forest">Hi, {member.name.split(" ")[0]}</h1>
        <p className="text-muted mt-1">{typeLabel} member</p>
        {isNewMember && interestSignupLabel && (
          <p className="text-xs text-muted mt-2">
            Thanks for joining our list on {interestSignupLabel}. Glad you stuck with us.
          </p>
        )}
      </header>

      {isFullMember ? (
        <Card className="glass-panel" data-testid="portal-door">
          <CardContent className="p-6">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold">Your door code</h2>
              <Link href="/portal/my-code" className="text-sm text-muted hover:text-foreground">
                {member.pin_code ? "Change" : "Set it"}
              </Link>
            </div>
            {member.pin_code ? (
              <RevealPin code={member.pin_code} slot={null} />
            ) : (
              <p className="text-sm text-warn mt-3">
                No code yet. <Link href="/portal/my-code" className="underline">Set your door code</Link> to get in.
              </p>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-2 mt-5 text-sm">
              <Link href="/portal/passes" className="text-sage hover:underline">
                Guest code{passesLeft > 0 ? ` (${passesLeft} ${passesLeft === 1 ? "pass" : "passes"} left)` : ""} →
              </Link>
              <HereToday count={hereNowCount} canSee={coopView} />
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <DayPassRedemptionHero member={member} />
          <div className="grid sm:grid-cols-2 gap-4" data-testid="portal-door">
            {freeDayClaim && (
              <Link href="/freeday">
                <Card className="glass-panel hover-lift cursor-pointer border border-gold/20">
                  <CardContent className="p-6">
                    {freeDayClaim.status === "activated" ? (
                      <>
                        <Zap className="w-8 h-8 text-gold mb-3" />
                        <h3 className="font-semibold mb-1">Free day active</h3>
                        <p className="text-sm text-muted">View your door code</p>
                      </>
                    ) : freeDayClaim.status === "reserved" ? (
                      <>
                        <Calendar className="w-8 h-8 text-gold mb-3" />
                        <h3 className="font-semibold mb-1">Free day reserved</h3>
                        <p className="text-sm text-muted">
                          {!freeDayClaim.claimed_date || freeDayClaim.claimed_date === new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date())
                            ? "Tap to get your door code — visit any weekday"
                            : `Reserved for ${new Date(freeDayClaim.claimed_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                        </p>
                      </>
                    ) : (
                      <>
                        <Clock className="w-8 h-8 text-sage mb-3" />
                        <h3 className="font-semibold mb-1">Application pending</h3>
                        <p className="text-sm text-muted">Your free day is being reviewed</p>
                      </>
                    )}
                  </CardContent>
                </Card>
              </Link>
            )}

            <Link href="/portal/passes">
              <Card className="glass-panel hover-lift cursor-pointer h-full">
                <CardContent className="p-6">
                  <Ticket className="w-8 h-8 text-sage mb-3" />
                  <h3 className="font-semibold mb-1">Day passes</h3>
                  <p className="text-sm text-muted">
                    {passesLeft > 0 ? `${passesLeft} left. Get a door code for today, or buy more.` : "Buy a day pass for door access."}
                  </p>
                </CardContent>
              </Card>
            </Link>
          </div>
          <p className="text-sm"><HereToday count={hereNowCount} canSee={coopView} /></p>
        </>
      )}

      <MembershipStatusCard
        memberType={member.member_type}
        approvedForDaily={!!member.approved_for_daily}
        applicationStatus={application?.status}
        applicationInterest={application?.membership_interest}
        hasActiveSubscription={!!activeSubscription}
      />

      {askDirectory && <DirectoryAsk />}

      {isNewMember && (
        <OnboardingChecklist
          needsPinCode={isFullMember}
          hasPinCode={!!member.pin_code}
          hasPhoto={!!member.profile_photo_url}
          hasBio={!!member.bio}
          hasTelegram={!!member.telegram_username}
        />
      )}

      <InstallPrompt eligible={installPromptEligible} />

      {/* Your plan: shown for any active subscription (desk or daily tiers) */}
      {activeSubscription && (
        <Card className="glass-panel" data-testid="portal-membership">
          <CardContent className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h3 className="font-semibold mb-1">
                  Membership
                  {activeSubscription.plan_key && (
                    <span className="text-muted font-normal ml-2 text-sm">
                      · {planLabel(activeSubscription.plan_key)} · ${((typeof activeSubscription.net_cents === "number" ? activeSubscription.net_cents : activeSubscription.monthly_cents) / 100)}/mo
                    </span>
                  )}
                </h3>
                {activeSubscription.cancel_at_period_end && activeSubscription.current_period_end && (
                  <p className="text-sm text-warn flex items-center gap-1.5">
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
                  <p className="text-sm text-danger flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4" />
                    {activeSubscription.payment_rail === "onchain" ? "USDC renewal past due" : "Payment failed — update your card to keep access"}
                  </p>
                )}
                {activeSubscription.status === "incomplete" && (
                  <p className="text-sm text-warn flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4" />
                    Awaiting your first USDC payment — access starts after confirmation
                  </p>
                )}
                {pendingSwitch && (
                  <p className="text-sm text-warn flex items-start gap-1.5 max-w-md">
                    <CalendarClock className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                      Switching to <strong className="text-foreground">{pendingSwitch.label}</strong> on{" "}
                      {new Date(pendingSwitch.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Denver" })}.
                      You keep {pendingSwitch.keeps} and your door code until then.
                    </span>
                  </p>
                )}
                {!pendingSwitch && !activeSubscription.cancel_at_period_end && !["past_due", "incomplete"].includes(activeSubscription.status) && (
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
                    currentPeriodEnd={activeSubscription.current_period_end}
                    hasDiscount={(activeSubscription.discount_cents ?? 0) > 0}
                  />
                )}
                {pendingSwitch && activeSubscription.payment_rail === "stripe" && (
                  <CancelPlanSwitchButton keepLabel={planLabel(activeSubscription.plan_key)} />
                )}
                {activeSubscription.payment_rail === "stripe" && <ManageSubscriptionButton />}
              </div>
            </div>
            {activeSubscription.payment_rail === "onchain" && (
              <div className="mt-4">
                <OnchainBillingCard
                  walletAddress={onchainWallet?.address ?? null}
                  walletVerifiedBySignature={onchainWallet?.verification_method === "signature"}
                  invoice={onchainInvoice ? {
                    id: onchainInvoice.id,
                    amountCents: onchainInvoice.amount_cents,
                    couponCode: onchainInvoice.coupon_code,
                    couponDiscountCents: onchainInvoice.coupon_discount_cents,
                    amountMicros: onchainInvoice.amount_usdc_micros,
                    dueAt: onchainInvoice.due_at,
                    status: onchainInvoice.status,
                    txHash: onchainInvoice.submitted_tx_hash,
                  } : null}
                  tokenAddress={NATIVE_USDC_ADDRESS}
                  treasuryAddress={TREASURY_ADDRESS}
                  configured={isOnchainBillingConfigured()}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {idleWallet && (
        <Card className="glass-panel border border-sage/20">
          <CardContent className="p-6 space-y-2">
            <div className="flex items-center gap-2">
              <Wallet className="w-4 h-4 text-sage" />
              <h3 className="font-semibold">Crypto wallet</h3>
            </div>
            <p className="text-sm text-muted">Linked to this account. No crypto membership uses it right now.</p>
            <p className="text-[11px] text-muted font-mono break-all">Linked wallet: {idleWallet.address}</p>
            <RemoveWalletButton walletId={idleWallet.id} address={idleWallet.address} />
          </CardContent>
        </Card>
      )}

      <nav aria-label="More" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted border-t border-rule pt-4" data-testid="portal-more">
        <Link href="/portal/profile" className="hover:text-foreground">Your profile</Link>
        {coopView && <Link href="/portal/access-log" className="hover:text-foreground">Who came in</Link>}
      </nav>

      {member.is_coop_member && <InviteCard />}

      <HubEssentials defaultExpanded={isNewMember && visitingToday} />
    </div>
  );
}

/** One quiet line instead of the old stats card: how many members came in today, and (co-op) who. */
function HereToday({ count, canSee }: { count: number; canSee: boolean }) {
  const text = count === 0 ? "Nobody in yet today" : `${count} ${count === 1 ? "member" : "members"} in today`;
  return canSee
    ? <Link href="/portal/access-log" className="text-muted hover:text-foreground" data-testid="here-today">{text} →</Link>
    : <span className="text-muted" data-testid="here-today">{text}</span>;
}

