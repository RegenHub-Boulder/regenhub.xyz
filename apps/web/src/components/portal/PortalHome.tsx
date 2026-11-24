import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Ticket, ClipboardList, CheckCircle, Clock, MessageCircle, Zap, Calendar, ArrowRight, AlertCircle, Wallet, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import HubEssentials from "@/components/portal/HubEssentials";
import InviteCard from "@/components/portal/InviteCard";
import { ManageSubscriptionButton } from "@/components/portal/ManageSubscriptionButton";
import { CancelPlanSwitchButton, ChangePlanButton } from "@/components/portal/ChangePlanButton";
import { DeskAsk } from "@/components/portal/DeskAsk";
import { VouchAsk } from "@/components/portal/VouchAsk";
import { OnboardingChecklist } from "@/components/portal/OnboardingChecklist";
import { DirectoryAsk } from "@/components/portal/DirectoryAsk";
import { RevealPin } from "@/components/portal/RevealPin";
import { DayPassRedemptionHero } from "@/components/portal/DayPassRedemptionHero";
import { MembershipStatusCard } from "@/components/portal/MembershipStatusCard";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { PreviewProvider } from "@/components/portal/PreviewContext";
import { planLabel, getPlan, isDeskPlan } from "@/lib/plans";
import { effectiveMonthlyCents } from "@/lib/stripeNet";
import { memberTypeLabel } from "@/lib/memberTypeLabel";
import { OnchainBillingCard } from "@/components/portal/OnchainBillingCard";
import { RemoveWalletButton } from "@/components/portal/RemoveWalletButton";
import { isOnchainBillingConfigured, NATIVE_USDC_ADDRESS, TREASURY_ADDRESS } from "@/lib/onchain/config";
import type { PortalHomeView } from "@/lib/portalHome";
import { FREE_DAY_LAPSE_DAYS } from "@regenhub/shared/prices";

/**
 * The member home (T-482): what a member comes for, most often first. The door (their code, a guest code), then
 * anything that needs them (a payment, a next step, first-week setup), then their plan, then everything else.
 * Renders `PortalHomeView` (lib/portalHome.ts) and reads nothing itself, so an admin's preview (lib/viewAs.ts) shows
 * exactly this page; in a preview every control is disabled (PreviewContext) and the server refuses writes anyway.
 */
export function PortalHome({ view }: { view: PortalHomeView }) {
  const page = <PortalHomeBody view={view} />;
  return view.preview ? <PreviewProvider>{page}</PreviewProvider> : page;
}

function PortalHomeBody({ view }: { view: PortalHomeView }) {
  const { member, application, freeDayClaim, nowMs, hereNowCount, installPromptEligible, onchainWallet, onchainInvoice, idleWallet, askDirectory } = view;
  const activeSubscription = view.subscription;
  const userEmail = view.userEmail;

  // Whether the member can swap plans via the in-portal change-plan flow. Source of truth is lib/plans.ts (selfServe
  // flag). A desk member can move to a daily plan; it takes effect when the paid period ends (lib/planSwitch.ts).
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
            {application.status === "pending" && (application.vouched_at
              ? "A member has vouched for you. A steward approves next, within a day."
              : "Next, one member who knows you vouches. Haven't met us yet? Come to a night or a free day.")}
            {application.status === "approved" && "You're approved. Reload in a moment to pick your plan."}
            {application.status === "rejected" && "Your application wasn't approved this time. Reach out on Telegram to learn more."}
          </p>
          <p className="text-xs text-muted mb-1">Submitted as: {application.email}</p>
        </div>
      );
    }

    return (
      <div className="space-y-6 max-w-md mx-auto mt-16">
        <div className="glass-panel p-8 text-center">
          <ClipboardList className="w-10 h-10 text-sage mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-3">Welcome — let&apos;s get you set up</h2>
          <p className="text-muted text-sm mb-6">
            You&apos;re signed in{userEmail ? (
              <> as <strong className="text-foreground">{userEmail}</strong></>
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

        {userEmail && (
        <div className="glass-panel p-6">
          <div className="flex items-start gap-3">
            <MessageCircle className="w-5 h-5 text-sage mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium mb-1">Already a member via Telegram?</p>
              <p className="text-xs text-muted leading-relaxed">
                If you have an existing account through our Telegram bot, send{" "}
                <code className="bg-tint px-1.5 py-0.5 rounded text-foreground">/email {userEmail}</code>{" "}
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
  const accountAgeMs = nowMs - new Date(member.created_at).getTime();
  const isNewMember = !member.pin_code || accountAgeMs < 7 * 24 * 60 * 60 * 1000;

  const interestSignupLabel = view.interestSignupAt
    ? new Date(view.interestSignupAt).toLocaleDateString("en-US", {
        timeZone: "America/Denver",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  // Hub Essentials (address, hours, Wi-Fi, keypad) opens by itself only on a newcomer's visit day: a door code live
  // right now (a day pass, or a free day activated today; the same code the day-pass hero shows). Free days have no
  // date any more, so a code is the only sign of the day. Every other day it starts closed, one click away.
  const visitingToday = !isFullMember && !!view.dayCode;

  const coopView = !!member.is_coop_member || !!member.is_admin;
  const passesLeft = member.day_passes_balance ?? 0;

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
          <DayPassRedemptionHero member={{ ...member, day_passes_balance: passesLeft }} activeCode={view.dayCode} nowMs={nowMs} />
          <div className="grid sm:grid-cols-2 gap-4" data-testid="portal-door">
            {freeDayClaim && (
              <Link href="/freeday">
                <Card className="glass-panel hover-lift cursor-pointer border border-gold/20">
                  <CardContent className="p-6">
                    {freeDayClaim.status === "activated" ? (
                      <>
                        <Zap className="w-8 h-8 text-gold mb-3" />
                        <h3 className="font-semibold mb-1">Free day used</h3>
                        <p className="text-sm text-muted">Your code that day, or how to come back</p>
                      </>
                    ) : freeDayClaim.status === "reserved" ? (
                      <>
                        <Calendar className="w-8 h-8 text-gold mb-3" />
                        <h3 className="font-semibold mb-1">Free day reserved</h3>
                        <p className="text-sm text-muted">
                          Tap to get your door code — visit any weekday
                        </p>
                      </>
                    ) : freeDayClaim.status === "expired" ? (
                      <>
                        <Calendar className="w-8 h-8 text-sage mb-3" />
                        <h3 className="font-semibold mb-1">Free day lapsed</h3>
                        <p className="text-sm text-muted">It wasn&apos;t used within {FREE_DAY_LAPSE_DAYS} days. Tap to ask again.</p>
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

      {view.vouchAsks.length > 0 && <VouchAsk asks={view.vouchAsks} />}

      <MembershipStatusCard
        memberType={member.member_type}
        approved={member.approved}
        deskAccess={member.desk_access}
        applicationStatus={application?.status}
        vouched={!!application?.vouched_at}
        hasActiveSubscription={!!activeSubscription}
        email={userEmail ?? undefined}
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
                      · {planLabel(activeSubscription.plan_key)} · ${effectiveMonthlyCents(activeSubscription) / 100}/mo
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
                    deskAccess={member.desk_access}
                  />
                )}
                {pendingSwitch && activeSubscription.payment_rail === "stripe" && (
                  <CancelPlanSwitchButton keepLabel={planLabel(activeSubscription.plan_key)} />
                )}
                {activeSubscription.payment_rail === "stripe" && <ManageSubscriptionButton />}
              </div>
            </div>
            {/* Desks are an upgrade for members: ask, a steward talks with you and turns desk access on. */}
            {!isDeskPlan(activeSubscription.plan_key) && (
              <div className="mt-4 border-t border-rule pt-4">
                {member.desk_access
                  ? <p className="text-sm text-muted" data-testid="desk-access-on">Your desk access is on: Change plan to pick a hot or cold desk.</p>
                  : <DeskAsk askedAt={member.desk_asked_at} />}
              </div>
            )}
            {activeSubscription.payment_rail === "onchain" && view.preview && (
              <div className="mt-4 text-sm text-muted space-y-1" data-testid="onchain-preview">
                <p>Pays in USDC.{onchainInvoice ? ` Open invoice: $${(onchainInvoice.amount_cents / 100).toFixed(2)}, ${onchainInvoice.status}.` : " Nothing due."}</p>
                <p className="text-xs">The wallet and payment controls are left out of the preview.</p>
              </div>
            )}
            {activeSubscription.payment_rail === "onchain" && !view.preview && (
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
