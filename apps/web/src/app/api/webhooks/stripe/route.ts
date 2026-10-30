import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe, planLabel } from "@/lib/stripe";
import { fulfillPassPurchase } from "@/lib/passFulfillment";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  sendEmail,
  subscriptionEndedEmail,
  paymentReminderEmail,
} from "@/lib/email";
import { downgradeMembershipAccess } from "@/lib/membershipLifecycle";
import { grantSubscriptionPasses } from "@/lib/subscriptionPasses";
import { isDeskPlan } from "@/lib/plans";
import { isActiveStatus, notifyTelegram, upsertSubscription, WebhookDataError } from "@/lib/stripeSubscriptionSync";

type ServiceClient = ReturnType<typeof createServiceClient>;

// Typed shapes for subscription→member joins (avoids @ts-expect-error)
type SubMemberNameRow = { member_id: number; members: { name: string } | null };
type SubMemberNameEmailRow = {
  member_id: number;
  members: { name: string; email: string | null } | null;
};

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
  return (await upsertSubscription(admin, sub, { isNew: true })).memberId;
}

async function handleSubscriptionUpdated(admin: ServiceClient, event: Stripe.Subscription): Promise<number | null> {
  // `prev` is the row as this delivery found it, to detect transitions.
  const { memberId, sub, prev } = await upsertSubscription(admin, event, { isNew: false });

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
      // A desk → daily switch still pending dies with the subscription.
      pending_plan_key: null,
      pending_plan_at: null,
      pending_plan_from: null,
      pending_plan_schedule_id: null,
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
  const wasDeskTier = isDeskPlan(row.plan_key);
  const slot = row.members?.pin_code_slot ?? null;

  let lockRevokeNote = "";
  const downgrade = await downgradeMembershipAccess(admin, {
    memberId: row.member_id,
    currentPinSlot: slot,
    revokePermanentPin: wasDeskTier,
  });
  if (downgrade.revokedSlot && downgrade.lockRevokeFailed) {
    lockRevokeNote = `\n\n⚠️ *Action needed:* Lock revoke failed for slot ${downgrade.revokedSlot}. Run Lock Sync from /admin/access.`;
  } else if (downgrade.revokedSlot && downgrade.lockStatus) {
    lockRevokeNote = `\n\n🔒 Cleared PIN slot ${downgrade.revokedSlot} on lock: ${downgrade.lockStatus}`;
  }
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
 * Idempotency: relies on UNIQUE(billing_event_key) — if the INSERT into pass_grants
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

  await grantSubscriptionPasses(admin, {
    memberId,
    subscriptionId: localSub?.id ?? null,
    planKey,
    billingEventKey: `stripe:${invoice.id}`,
    stripeInvoiceId: invoice.id,
    notifyMember: invoice.billing_reason !== "subscription_create",
  });
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
