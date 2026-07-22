import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe, getPlan, planLabel } from "@/lib/stripe";
import { fulfillPassPurchase } from "@/lib/passFulfillment";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  sendEmail,
  welcomeNewMemberEmail,
  subscriptionEndedEmail,
  paymentReminderEmail,
  monthlyPassesCreditedEmail,
} from "@/lib/email";
import type { StripeSubscriptionStatus } from "@/lib/supabase/types";
import {
  allocateSlotWithRetry,
  setUserCode,
  clearUserCode,
  formatLockStatus,
  generateRandomCode,
  MEMBER_SLOT_MIN,
  MEMBER_SLOT_MAX,
} from "@regenhub/shared";

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Throw this from a handler when the event is permanently un-processable
 * (e.g. missing or unknown metadata). Top-level returns 422 so Stripe marks
 * the delivery as failed (and stops retrying) and the issue is visible in
 * the Stripe Dashboard. Any other error → 500 → Stripe retries.
 */
class WebhookDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookDataError";
  }
}

// Typed shapes for subscription→member joins (avoids @ts-expect-error)
type SubMemberNameRow = { member_id: number; members: { name: string } | null };
type SubMemberNameEmailRow = {
  member_id: number;
  members: { name: string; email: string | null } | null;
};

function isActiveStatus(s: string | null | undefined): boolean {
  return s === "active" || s === "trialing";
}

async function notifyTelegram(text: string, opts?: { silent?: boolean }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        disable_notification: opts?.silent ?? false,
      }),
    });
  } catch (err) {
    console.error("[StripeWebhook] Telegram notify error:", err);
  }
}

export async function POST(request: Request) {
  const stripe = getStripe();
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Missing signature or webhook secret" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[Stripe] Webhook signature failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const admin = createServiceClient();

  // Try to claim this event. INSERT not UPSERT so a Stripe redelivery (same
  // event.id) hits 23505 instead of silently refreshing — that lets us
  // short-circuit the handler and skip duplicate side effects (welcome
  // Telegram, second magic link, etc). If the prior attempt errored, allow
  // a retry: delete the old "error" row and re-claim.
  const startedAt = Date.now();
  const { error: claimErr } = await admin.from("webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    status: "processing",
  });

  if (claimErr) {
    if ((claimErr as { code?: string }).code === "23505") {
      // Duplicate event id. Check the existing row's status.
      const { data: existing } = await admin
        .from("webhook_events")
        .select("status")
        .eq("stripe_event_id", event.id)
        .maybeSingle();
      const existingStatus = existing?.status ?? "unknown";

      if (existingStatus === "ok" || existingStatus === "data_error") {
        // Already processed successfully or marked unprocessable — ack and skip.
        console.log(`[Stripe] Duplicate event ${event.id} (${existingStatus}) — skipping side effects`);
        return NextResponse.json({ received: true, deduped: true, prior_status: existingStatus });
      }

      // Prior attempt errored (status='error') or is still in-flight ('processing').
      // Allow the retry to proceed by resetting the row.
      await admin
        .from("webhook_events")
        .update({ status: "processing", error_message: null, completed_at: null })
        .eq("stripe_event_id", event.id);
    } else {
      console.error("[Stripe] webhook_events insert failed:", claimErr);
      return NextResponse.json({ error: "Tracking failed" }, { status: 500 });
    }
  }

  // Capture the resolved member_id (if any) and the final status, then write back
  let resolvedMemberId: number | null = null;
  let finalStatus: "ok" | "data_error" | "error" = "ok";
  let errorMessage: string | null = null;

  async function recordCompletion() {
    await admin
      .from("webhook_events")
      .update({
        status: finalStatus,
        error_message: errorMessage,
        member_id: resolvedMemberId,
        duration_ms: Date.now() - startedAt,
        completed_at: new Date().toISOString(),
      })
      .eq("stripe_event_id", event.id);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        resolvedMemberId = await handleCheckoutCompleted(admin, event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.created":
        resolvedMemberId = await handleSubscriptionCreated(admin, event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.updated":
        resolvedMemberId = await handleSubscriptionUpdated(admin, event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        resolvedMemberId = await handleSubscriptionDeleted(admin, event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_succeeded":
        resolvedMemberId = await handleInvoicePaymentSucceeded(admin, event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_failed":
        resolvedMemberId = await handleInvoicePaymentFailed(admin, event.data.object as Stripe.Invoice);
        break;
      default:
        // Unhandled event types — Stripe sends a lot we don't care about
        break;
    }
    await recordCompletion();
  } catch (err) {
    if (err instanceof WebhookDataError) {
      finalStatus = "data_error";
      errorMessage = err.message;
      await recordCompletion();
      console.warn(`[Stripe] Unprocessable ${event.type} (${event.id}): ${err.message}`);
      await notifyTelegram(
        `⚠️ *Stripe webhook unprocessable*\n\n${event.type}\n\`${err.message}\``,
        { silent: true },
      );
      return NextResponse.json({ skipped: err.message }, { status: 422 });
    }
    finalStatus = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    await recordCompletion();
    console.error(`[Stripe] Error handling ${event.type} (${event.id}):`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// =====================================================
// Handlers
// =====================================================

async function handleCheckoutCompleted(
  admin: ServiceClient,
  session: Stripe.Checkout.Session,
): Promise<number | null> {
  if (session.mode === "subscription") {
    // Subscriptions get granted on customer.subscription.created — more
    // authoritative since we read the live subscription state there.
    return null;
  }
  // mode === 'payment' → day pass / 5-pack — delegate to shared helper.
  // Idempotent: the success page may have already fulfilled this session.
  const result = await fulfillPassPurchase(session, admin);
  return result.member_id ?? null;
}

async function handleSubscriptionCreated(
  admin: ServiceClient,
  sub: Stripe.Subscription,
): Promise<number | null> {
  return upsertSubscription(admin, sub, { isNew: true });
}

async function handleSubscriptionUpdated(admin: ServiceClient, sub: Stripe.Subscription): Promise<number | null> {
  // Capture previous state to detect transitions
  const { data: prev } = await admin
    .from("subscriptions")
    .select("status, cancel_at_period_end, past_due_since")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();

  const memberId = await upsertSubscription(admin, sub, { isNew: false });

  const newStatus = sub.status;

  // Transitions worth telling humans about
  if (prev) {
    // Cancellation queued
    if (!prev.cancel_at_period_end && sub.cancel_at_period_end) {
      const { data: row } = await admin
        .from("subscriptions")
        .select("member_id, members(name)")
        .eq("stripe_subscription_id", sub.id)
        .returns<SubMemberNameRow[]>()
        .maybeSingle();
      const periodEndUnix = sub.items.data[0]?.current_period_end;
      const endDate = periodEndUnix
        ? new Date(periodEndUnix * 1000).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "the end of the period";
      const name = row?.members?.name ?? "A member";
      await notifyTelegram(
        `📤 *Subscription cancellation queued*\n\n${name} cancelled, effective ${endDate}. Maybe reach out?`,
      );
    }

    // Entered past_due
    if (prev.status !== "past_due" && newStatus === "past_due") {
      const { data: row } = await admin
        .from("subscriptions")
        .select("member_id, plan_key, monthly_cents, members(name, email)")
        .eq("stripe_subscription_id", sub.id)
        .returns<(SubMemberNameEmailRow & { plan_key: string; monthly_cents: number })[]>()
        .maybeSingle();
      const name = row?.members?.name ?? "A member";
      const email = row?.members?.email ?? "";
      await notifyTelegram(
        `⚠️ *Payment failed*\n\n${name} (${email}) — card needs attention. 7-day grace period started.`,
      );
      // Email the member directly — until now only the group heard about
      // failed payments; the member found out when their access lapsed.
      if (email && row) {
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
        const tpl = paymentReminderEmail({
          name,
          planLabel: planLabel(row.plan_key),
          monthlyDollars: row.monthly_cents / 100,
          siteUrl,
          daysOverdue: null,
        });
        sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text })
          .catch((err) => console.error("[Webhook] Past-due email failed:", err));
      }
    }

    // Recovered from past_due
    if (prev.status === "past_due" && isActiveStatus(newStatus)) {
      const { data: row } = await admin
        .from("subscriptions")
        .select("member_id, members(name)")
        .eq("stripe_subscription_id", sub.id)
        .returns<SubMemberNameRow[]>()
        .maybeSingle();
      const name = row?.members?.name ?? "A member";
      await notifyTelegram(`✅ ${name}'s payment recovered — back in good standing.`, {
        silent: true,
      });
    }
  }

  return memberId;
}

async function handleSubscriptionDeleted(admin: ServiceClient, sub: Stripe.Subscription): Promise<number | null> {
  // Mark canceled in local mirror
  await admin
    .from("subscriptions")
    .update({
      status: sub.status,
      canceled_at: new Date().toISOString(),
      cancel_at_period_end: sub.cancel_at_period_end,
    })
    .eq("stripe_subscription_id", sub.id);

  // Look up member + their current slot/code so we can revoke if this was
  // a desk tier (cold/hot). For day-pass / social tiers there's no slot to free.
  const { data: row } = await admin
    .from("subscriptions")
    .select("member_id, plan_key, members(name, email, pin_code_slot, member_type)")
    .eq("stripe_subscription_id", sub.id)
    .returns<{
      member_id: number;
      plan_key: string;
      members: { name: string; email: string | null; pin_code_slot: number | null; member_type: string } | null;
    }[]>()
    .maybeSingle();

  if (!row?.member_id) return null;

  const name = row.members?.name ?? "A member";
  const cancelledPlan = getPlan(row.plan_key);
  const wasDeskTier =
    cancelledPlan?.grantsMemberType === "cold_desk" ||
    cancelledPlan?.grantsMemberType === "hot_desk";
  const slot = row.members?.pin_code_slot ?? null;

  // Flip member back to day_pass (they keep portal/day-pass access)
  const memberUpdate: { member_type: "day_pass"; pin_code_slot?: null; pin_code?: null } = {
    member_type: "day_pass",
  };
  let lockRevokeNote = "";
  if (wasDeskTier && slot) {
    memberUpdate.pin_code_slot = null;
    memberUpdate.pin_code = null;
    try {
      const lockResults = await clearUserCode(slot);
      lockRevokeNote = `\n\n🔒 Cleared PIN slot ${slot} on lock: ${formatLockStatus(lockResults)}`;
    } catch (err) {
      console.error("[Webhook] Failed to revoke lock code on cancel:", err);
      lockRevokeNote = `\n\n⚠️ *Action needed:* Lock revoke failed for slot ${slot}. Run Lock Sync from /admin/access.`;
    }
  }

  await admin.from("members").update(memberUpdate).eq("id", row.member_id);
  await notifyTelegram(
    `👋 ${name}'s ${planLabel(row.plan_key)} subscription ended. Now on day-pass status.${lockRevokeNote}`,
  );

  // Tell the member — their access just changed (desk members lose their
  // permanent PIN) and silence here reads as a door slam.
  if (row.members?.email) {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
    const tpl = subscriptionEndedEmail({
      name,
      planLabel: planLabel(row.plan_key),
      wasDeskTier,
      siteUrl,
    });
    sendEmail({ to: row.members.email, subject: tpl.subject, html: tpl.html, text: tpl.text })
      .catch((err) => console.error("[Webhook] Subscription-ended email failed:", err));
  }
  return row.member_id;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (typeof sub === "string") return sub;
  if (sub && typeof sub === "object") return sub.id;
  return null;
}

async function handleInvoicePaymentSucceeded(
  admin: ServiceClient,
  invoice: Stripe.Invoice,
): Promise<number | null> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return null;

  // Clear past_due state on the renewal
  await admin
    .from("subscriptions")
    .update({ past_due_since: null })
    .eq("stripe_subscription_id", subId);

  // For plans with monthlyDayPasses, credit the member's balance.
  // Idempotent via UNIQUE(stripe_invoice_id) on pass_grants.
  return maybeGrantMonthlyPasses(admin, invoice, subId);
}

/**
 * Credit monthly day passes if the subscription's plan defines `monthlyDayPasses`.
 * Idempotency: relies on UNIQUE(stripe_invoice_id) — if the INSERT into pass_grants
 * conflicts, the balance is NOT incremented.
 */
async function maybeGrantMonthlyPasses(
  admin: ServiceClient,
  invoice: Stripe.Invoice,
  subId: string,
): Promise<number | null> {
  // Local subscription row (created by handleSubscriptionCreated) gives us
  // plan_key + member_id + local sub.id for the grant audit trail.
  const { data: localSub } = await admin
    .from("subscriptions")
    .select("id, member_id, plan_key")
    .eq("stripe_subscription_id", subId)
    .maybeSingle();

  // Fallback: subscription metadata is mirrored onto the invoice
  const planKey =
    localSub?.plan_key ??
    (invoice.parent?.subscription_details?.metadata?.plan_key as string | undefined);
  if (!planKey) {
    console.warn(`[Stripe] No plan_key found for invoice ${invoice.id} (sub ${subId})`);
    return localSub?.member_id ?? null;
  }

  const plan = getPlan(planKey);
  if (!plan || !plan.monthlyDayPasses || plan.monthlyDayPasses <= 0) {
    return localSub?.member_id ?? null;
  }

  // Resolve member: prefer local subscription row, fall back to customer lookup
  let memberId = localSub?.member_id ?? null;
  if (!memberId) {
    const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
    if (customerId) {
      const { data: m } = await admin
        .from("members")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      memberId = m?.id ?? null;
    }
  }
  if (!memberId) {
    console.warn(`[Stripe] No member resolved for invoice ${invoice.id}`);
    return null;
  }

  if (!invoice.id) {
    console.warn("[Stripe] Invoice missing id, skipping grant");
    return memberId;
  }

  // Idempotent insert — UNIQUE on stripe_invoice_id prevents double-grant on redelivery
  const { data: inserted, error: insertErr } = await admin
    .from("pass_grants")
    .insert({
      member_id: memberId,
      subscription_id: localSub?.id ?? null,
      stripe_invoice_id: invoice.id,
      plan_key: planKey,
      passes_granted: plan.monthlyDayPasses,
    })
    .select("id")
    .maybeSingle();

  // PG unique violation code is 23505 — that's the "already granted" case
  if (insertErr) {
    if (insertErr.code === "23505") return memberId; // already granted
    console.error("[Stripe] pass_grants insert failed:", insertErr);
    return memberId;
  }
  if (!inserted) return memberId;

  const { data: newBalance, error: rpcError } = await admin.rpc(
    "increment_day_pass_balance",
    { p_member_id: memberId, p_amount: plan.monthlyDayPasses },
  );
  if (rpcError) {
    console.error("[Stripe] Failed to grant monthly passes:", rpcError);
    // Rollback the grant row so a retry can succeed
    await admin.from("pass_grants").delete().eq("id", inserted.id);
    return memberId;
  }

  console.log(
    `[Stripe] +${plan.monthlyDayPasses} monthly passes for member ${memberId} (plan=${planKey}, invoice=${invoice.id}) → balance=${newBalance}`,
  );

  // Tell the member their passes landed — but skip the subscription's FIRST
  // invoice: the welcome email already covers activation, and stacking two
  // emails in the same minute reads as spam.
  if (invoice.billing_reason !== "subscription_create") {
    const { data: m } = await admin
      .from("members")
      .select("name, email")
      .eq("id", memberId)
      .maybeSingle();
    if (m?.email) {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
      const tpl = monthlyPassesCreditedEmail({
        name: m.name,
        quantity: plan.monthlyDayPasses,
        newBalance: typeof newBalance === "number" ? newBalance : null,
        planLabel: planLabel(planKey),
        siteUrl,
      });
      sendEmail({ to: m.email, subject: tpl.subject, html: tpl.html, text: tpl.text })
        .catch((err) => console.error("[Stripe] Monthly-credit email failed:", err));
    }
  }
  return memberId;
}

async function handleInvoicePaymentFailed(
  admin: ServiceClient,
  invoice: Stripe.Invoice,
): Promise<number | null> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return null;

  // Only set past_due_since if not already set (preserve original failure time)
  const { data: existing } = await admin
    .from("subscriptions")
    .select("past_due_since, member_id")
    .eq("stripe_subscription_id", subId)
    .maybeSingle();

  if (!existing?.past_due_since) {
    await admin
      .from("subscriptions")
      .update({ past_due_since: new Date().toISOString() })
      .eq("stripe_subscription_id", subId);
  }
  return existing?.member_id ?? null;
}

// =====================================================
// Sub upsert + side effects
// =====================================================

async function upsertSubscription(
  admin: ServiceClient,
  sub: Stripe.Subscription,
  { isNew }: { isNew: boolean },
): Promise<number | null> {
  // Plan key comes from metadata set at checkout creation. No fallback — if
  // metadata is missing, something's wrong with how the sub was created
  // (likely created manually in Stripe Dashboard, not via our admin flow).
  const planKey = sub.metadata?.plan_key;
  if (!planKey) {
    throw new WebhookDataError(`subscription ${sub.id} has no plan_key in metadata`);
  }
  const plan = getPlan(planKey);
  if (!plan) {
    throw new WebhookDataError(`subscription ${sub.id} has unknown plan_key "${planKey}"`);
  }

  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? "";
  // Stripe v20 reports the actual recurring amount on the SubscriptionItem's price
  const monthlyCents = item?.price?.unit_amount ?? parseInt(sub.metadata?.monthly_cents ?? "0", 10);

  // Resolve member by Stripe customer ID
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  let { data: member } = await admin
    .from("members")
    .select("id, name, email, day_passes_balance, supabase_user_id, pin_code_slot")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  // Fallback: lookup by metadata.member_id (set in createApprovalCheckoutSession)
  if (!member && sub.metadata?.member_id) {
    const memberId = parseInt(sub.metadata.member_id, 10);
    if (Number.isFinite(memberId)) {
      const { data: m } = await admin
        .from("members")
        .select("id, name, email, day_passes_balance, supabase_user_id, pin_code_slot")
        .eq("id", memberId)
        .maybeSingle();
      if (m) {
        member = m;
        // Backfill customer ID
        await admin
          .from("members")
          .update({ stripe_customer_id: customerId })
          .eq("id", m.id);
      }
    }
  }

  if (!member) {
    throw new WebhookDataError(
      `subscription ${sub.id} has no resolvable member (customer ${customerId})`,
    );
  }

  // Pull discount snapshot from the originating application (source of truth
  // for what admin approved). Stripe v20 returns sub.discounts as bare IDs;
  // we'd have to retrieve each one. The application has the same info.
  let discountSnapshot: {
    cents: number | null;
    duration: "forever" | "repeating" | null;
    months: number | null;
    note: string | null;
  } = { cents: null, duration: null, months: null, note: null };
  const appIdStr = sub.metadata?.application_id;
  if (appIdStr) {
    const appId = parseInt(appIdStr, 10);
    if (Number.isFinite(appId)) {
      const { data: app } = await admin
        .from("applications")
        .select("discount_cents, discount_duration, discount_months, discount_note")
        .eq("id", appId)
        .maybeSingle();
      if (app) {
        discountSnapshot = {
          cents: app.discount_cents,
          duration: app.discount_duration,
          months: app.discount_months,
          note: app.discount_note,
        };
      }
    }
  }

  const status = sub.status as StripeSubscriptionStatus;
  // Stripe v20 moved current_period_end to the SubscriptionItem (per-item billing periods)
  const periodEndUnix = sub.items.data[0]?.current_period_end;
  const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null;

  const row = {
    member_id: member.id,
    stripe_subscription_id: sub.id,
    stripe_customer_id: customerId,
    stripe_price_id: priceId,
    plan_key: planKey,
    monthly_cents: monthlyCents,
    status,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    discount_cents: discountSnapshot.cents,
    discount_duration: discountSnapshot.duration,
    discount_months: discountSnapshot.months,
    discount_note: discountSnapshot.note,
  };

  await admin.from("subscriptions").upsert(row, { onConflict: "stripe_subscription_id" });

  // Side effects: only grant access when status flips to active/trialing
  let autoAllocatedSlot: number | null = null;
  let autoAllocationFailure: string | null = null;
  if (isActiveStatus(status)) {
    // Only update member_type if the plan grants physical access
    if (plan.grantsMemberType) {
      await admin
        .from("members")
        .update({ member_type: plan.grantsMemberType, disabled: false })
        .eq("id", member.id);
    } else {
      // Digital-only plan — just clear disabled flag
      await admin.from("members").update({ disabled: false }).eq("id", member.id);
    }

    // Clear any stale past_due_since on grant
    await admin
      .from("subscriptions")
      .update({ past_due_since: null, access_disabled_at: null })
      .eq("stripe_subscription_id", sub.id);

    // Desk-tier self-serve: auto-allocate a permanent PIN slot + push to lock.
    // Without this, a $250/$500 subscriber pays then sees "No slot assigned"
    // on /portal/my-code. Skip if a slot is already assigned (admin pre-allocated
    // or sub flapped). Skip non-desk plans (hub_friend is comp, social tiers
    // don't get permanent slots).
    const needsSlot =
      (plan.grantsMemberType === "cold_desk" || plan.grantsMemberType === "hot_desk") &&
      !member.pin_code_slot;
    if (needsSlot) {
      const code = generateRandomCode();
      const allocation = await allocateSlotWithRetry<{ id: number; pin_code_slot: number }>({
        min: MEMBER_SLOT_MIN,
        max: MEMBER_SLOT_MAX,
        getUsedSlots: async () => {
          const { data } = await admin
            .from("members")
            .select("pin_code_slot")
            .not("pin_code_slot", "is", null);
          return new Set((data ?? []).map((r) => r.pin_code_slot as number));
        },
        tryInsert: (slot) =>
          admin
            .from("members")
            .update({ pin_code_slot: slot, pin_code: code })
            .eq("id", member.id)
            .select("id, pin_code_slot")
            .single(),
      });

      if (allocation.ok) {
        autoAllocatedSlot = allocation.slot;
        try {
          const lockResults = await setUserCode(allocation.slot, code);
          // A door that didn't respond OR accepted-but-may-not-have-landed
          // (low battery / offline) both warrant a heads-up to the admin.
          const lockStatus = formatLockStatus(lockResults);
          autoAllocationFailure = /didn't respond|may not/i.test(lockStatus)
            ? `lock push partial: ${lockStatus}`
            : null;
        } catch (err) {
          console.error("[Webhook] setUserCode failed for new desk member:", err);
          autoAllocationFailure = "lock push failed — needs Lock Sync";
        }
      } else {
        console.error("[Webhook] Slot allocation failed for new desk member:", allocation.error);
        autoAllocationFailure = allocation.exhausted
          ? "no slots available (1-100 exhausted)"
          : `allocation error: ${allocation.error}`;
      }
    }

    // First-time activation side effects (new subscription, not a status flap)
    if (isNew) {
      // Mark the originating application complete (if there was one)
      if (sub.metadata?.application_id) {
        const appId = parseInt(sub.metadata.application_id, 10);
        if (Number.isFinite(appId)) {
          await admin
            .from("applications")
            .update({ checkout_completed_at: new Date().toISOString() })
            .eq("id", appId);
        }
      }

      // If this new subscriber has no auth account yet (self-serve signup
      // without prior login), send a magic link so they can claim their
      // portal. Mirrors first-time day-pass buyer flow.
      if (!member.supabase_user_id && member.email) {
        const baseUrl =
          process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";
        const { error: otpErr } = await admin.auth.signInWithOtp({
          email: member.email,
          options: {
            emailRedirectTo: `${baseUrl}/auth/callback?next=/portal`,
            shouldCreateUser: true,
          },
        });
        if (otpErr) console.error("[Webhook] OTP send failed:", otpErr);
      }

      const passesNote =
        member.day_passes_balance > 0
          ? ` (${member.day_passes_balance} guest passes carried forward)`
          : "";
      const source = sub.metadata?.source ? ` · via ${sub.metadata.source}` : "";
      const slotNote = autoAllocatedSlot
        ? `\n\n🔑 Auto-allocated PIN slot ${autoAllocatedSlot} + pushed to lock.`
        : "";
      const failNote = autoAllocationFailure
        ? `\n\n⚠️ *Action needed:* ${autoAllocationFailure}. Run Lock Sync from /admin/access.`
        : "";
      await notifyTelegram(
        `🎉 *New member!*\n\n*${member.name}* is now on ${planLabel(planKey)} ($${monthlyCents / 100}/mo)${passesNote}${source}.${slotNote}${failNote}`,
      );

      // Welcome the member themselves — the group celebrated, but until now
      // the person who just paid heard nothing directly.
      if (member.email) {
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
        const isDeskTier =
          plan.grantsMemberType === "cold_desk" || plan.grantsMemberType === "hot_desk";
        const tpl = welcomeNewMemberEmail({
          name: member.name,
          planLabel: planLabel(planKey),
          monthlyDollars: monthlyCents / 100,
          isDeskTier,
          siteUrl,
        });
        sendEmail({ to: member.email, subject: tpl.subject, html: tpl.html, text: tpl.text })
          .catch((err) => console.error("[Webhook] Welcome email failed:", err));
      }
    }
  }

  return member.id;
}
