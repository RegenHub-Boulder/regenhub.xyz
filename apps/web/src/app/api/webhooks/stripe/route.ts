import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe, getPlan, planLabel } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/admin";
import type { StripeSubscriptionStatus } from "@/lib/supabase/types";

type ServiceClient = ReturnType<typeof createServiceClient>;

// Map Stripe price IDs → number of day passes granted (one-time purchases)
function passCountForPrice(priceId: string): number {
  if (priceId === process.env.STRIPE_PRICE_DAYPASS) return 1;
  if (priceId === process.env.STRIPE_PRICE_FIVEPACK) return 5;
  return 0;
}

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

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(admin, event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.created":
        await handleSubscriptionCreated(admin, event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(admin, event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(admin, event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(admin, event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(admin, event.data.object as Stripe.Invoice);
        break;
      default:
        // Unhandled event types — Stripe sends a lot we don't care about
        break;
    }
  } catch (err) {
    console.error(`[Stripe] Error handling ${event.type}:`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// =====================================================
// Handlers
// =====================================================

async function handleCheckoutCompleted(admin: ServiceClient, session: Stripe.Checkout.Session) {
  if (session.mode === "subscription") {
    // The actual grant happens on customer.subscription.created — more
    // authoritative since we read the live subscription state.
    return;
  }

  // mode === 'payment' → existing day pass / 5-pack flow
  const stripe = getStripe();
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });

  let passCount = 0;
  let kind: "day_pass" | "five_pack" | null = null;
  for (const item of lineItems.data) {
    const priceId = item.price?.id;
    if (!priceId) continue;
    const count = passCountForPrice(priceId) * (item.quantity ?? 1);
    passCount += count;
    if (count === 1 && !kind) kind = "day_pass";
    if (count === 5) kind = "five_pack";
  }

  if (passCount === 0 || !kind) {
    console.warn("[Stripe] No matching price IDs in session", session.id);
    return;
  }

  // Resolve the member: prefer client_reference_id, fall back to email
  const customerEmail =
    session.customer_details?.email ??
    session.customer_email ??
    null;

  let memberId: number | null = null;
  let memberName: string | null = null;
  let isFirstTime = false;

  if (session.client_reference_id) {
    const id = parseInt(session.client_reference_id, 10);
    if (Number.isFinite(id)) {
      const { data: m } = await admin
        .from("members")
        .select("id, name")
        .eq("id", id)
        .maybeSingle();
      if (m) {
        memberId = m.id;
        memberName = m.name;
      }
    }
  }

  if (!memberId && customerEmail) {
    const { data: m } = await admin
      .from("members")
      .select("id, name")
      .eq("email", customerEmail)
      .maybeSingle();
    if (m) {
      memberId = m.id;
      memberName = m.name;
    } else {
      // First-time buyer: auto-create a day_pass member
      const name = session.customer_details?.name?.trim() || customerEmail.split("@")[0];
      const { data: created } = await admin
        .from("members")
        .insert({
          name,
          email: customerEmail,
          member_type: "day_pass",
        })
        .select("id, name")
        .single();
      if (created) {
        memberId = created.id;
        memberName = created.name;
        isFirstTime = true;
      }
    }
  }

  if (!memberId) {
    console.error("[Stripe] Could not resolve member for session", session.id);
    return;
  }

  // Increment balance atomically
  const { data: newBalance, error: rpcError } = await admin.rpc(
    "increment_day_pass_balance",
    { p_member_id: memberId, p_amount: passCount },
  );
  if (rpcError) {
    console.error("[Stripe] Failed to increment balance:", rpcError);
    throw rpcError;
  }

  // Audit log — idempotent on stripe_checkout_session
  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  await admin.from("purchases").upsert(
    {
      member_id: memberId,
      stripe_checkout_session: session.id,
      stripe_payment_intent: paymentIntent,
      kind,
      amount_cents: session.amount_total ?? 0,
      passes_granted: passCount,
      email: customerEmail,
    },
    { onConflict: "stripe_checkout_session" },
  );

  console.log(
    `[Stripe] +${passCount} passes for ${memberName} (id=${memberId}) → balance=${newBalance}`,
  );

  if (isFirstTime) {
    const reviewUrl = `https://regenhub.xyz/admin/members/${memberId}`;
    await notifyTelegram(
      [
        `🆕 *First-time day-pass buyer*`,
        ``,
        `*${memberName}* · ${customerEmail}`,
        `Bought: ${kind === "five_pack" ? "5-Pack" : "Day Pass"} ($${(session.amount_total ?? 0) / 100})`,
        ``,
        `[Review →](${reviewUrl})`,
      ].join("\n"),
    );
  }
}

async function handleSubscriptionCreated(admin: ServiceClient, sub: Stripe.Subscription) {
  await upsertSubscription(admin, sub, { isNew: true });
}

async function handleSubscriptionUpdated(admin: ServiceClient, sub: Stripe.Subscription) {
  // Capture previous state to detect transitions
  const { data: prev } = await admin
    .from("subscriptions")
    .select("status, cancel_at_period_end, past_due_since")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();

  await upsertSubscription(admin, sub, { isNew: false });

  const newStatus = sub.status;

  // Transitions worth telling humans about
  if (prev) {
    // Cancellation queued
    if (!prev.cancel_at_period_end && sub.cancel_at_period_end) {
      const { data: member } = await admin
        .from("subscriptions")
        .select("member_id, members(name)")
        .eq("stripe_subscription_id", sub.id)
        .single();
      const periodEndUnix = sub.items.data[0]?.current_period_end;
      const endDate = periodEndUnix
        ? new Date(periodEndUnix * 1000).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "the end of the period";
      // @ts-expect-error nested join shape
      const name = member?.members?.name ?? "A member";
      await notifyTelegram(
        `📤 *Subscription cancellation queued*\n\n${name} cancelled, effective ${endDate}. Maybe reach out?`,
      );
    }

    // Entered past_due
    if (prev.status !== "past_due" && newStatus === "past_due") {
      const { data: row } = await admin
        .from("subscriptions")
        .select("member_id, members(name, email)")
        .eq("stripe_subscription_id", sub.id)
        .single();
      // @ts-expect-error nested join shape
      const name = row?.members?.name ?? "A member";
      // @ts-expect-error nested join shape
      const email = row?.members?.email ?? "";
      await notifyTelegram(
        `⚠️ *Payment failed*\n\n${name} (${email}) — card needs attention. 7-day grace period started.`,
      );
    }

    // Recovered from past_due
    if (prev.status === "past_due" && isActiveStatus(newStatus)) {
      const { data: row } = await admin
        .from("subscriptions")
        .select("members(name)")
        .eq("stripe_subscription_id", sub.id)
        .single();
      // @ts-expect-error nested join shape
      const name = row?.members?.name ?? "A member";
      await notifyTelegram(`✅ ${name}'s payment recovered — back in good standing.`, {
        silent: true,
      });
    }
  }
}

async function handleSubscriptionDeleted(admin: ServiceClient, sub: Stripe.Subscription) {
  // Mark canceled in local mirror
  await admin
    .from("subscriptions")
    .update({
      status: sub.status,
      canceled_at: new Date().toISOString(),
      cancel_at_period_end: sub.cancel_at_period_end,
    })
    .eq("stripe_subscription_id", sub.id);

  // Flip member back to day_pass (they keep portal/day-pass access)
  const { data: row } = await admin
    .from("subscriptions")
    .select("member_id, members(name)")
    .eq("stripe_subscription_id", sub.id)
    .single();
  if (row?.member_id) {
    await admin.from("members").update({ member_type: "day_pass" }).eq("id", row.member_id);
    // @ts-expect-error nested join shape
    const name = row.members?.name ?? "A member";
    await notifyTelegram(`👋 ${name}'s subscription ended. Now on day-pass status.`);
  }
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (typeof sub === "string") return sub;
  if (sub && typeof sub === "object") return sub.id;
  return null;
}

async function handleInvoicePaymentSucceeded(admin: ServiceClient, invoice: Stripe.Invoice) {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return;

  // Clear past_due state on the renewal
  await admin
    .from("subscriptions")
    .update({ past_due_since: null })
    .eq("stripe_subscription_id", subId);

  // For plans with monthlyDayPasses, credit the member's balance.
  // Idempotent via UNIQUE(stripe_invoice_id) on pass_grants.
  await maybeGrantMonthlyPasses(admin, invoice, subId);
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
) {
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
    return;
  }

  const plan = getPlan(planKey);
  if (!plan || !plan.monthlyDayPasses || plan.monthlyDayPasses <= 0) return;

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
    return;
  }

  if (!invoice.id) {
    console.warn("[Stripe] Invoice missing id, skipping grant");
    return;
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
    if (insertErr.code === "23505") return;
    console.error("[Stripe] pass_grants insert failed:", insertErr);
    return;
  }
  if (!inserted) return;

  const { data: newBalance, error: rpcError } = await admin.rpc(
    "increment_day_pass_balance",
    { p_member_id: memberId, p_amount: plan.monthlyDayPasses },
  );
  if (rpcError) {
    console.error("[Stripe] Failed to grant monthly passes:", rpcError);
    // Rollback the grant row so a retry can succeed
    await admin.from("pass_grants").delete().eq("id", inserted.id);
    return;
  }

  console.log(
    `[Stripe] +${plan.monthlyDayPasses} monthly passes for member ${memberId} (plan=${planKey}, invoice=${invoice.id}) → balance=${newBalance}`,
  );
}

async function handleInvoicePaymentFailed(admin: ServiceClient, invoice: Stripe.Invoice) {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return;

  // Only set past_due_since if not already set (preserve original failure time)
  const { data: existing } = await admin
    .from("subscriptions")
    .select("past_due_since")
    .eq("stripe_subscription_id", subId)
    .maybeSingle();

  if (!existing?.past_due_since) {
    await admin
      .from("subscriptions")
      .update({ past_due_since: new Date().toISOString() })
      .eq("stripe_subscription_id", subId);
  }
}

// =====================================================
// Sub upsert + side effects
// =====================================================

async function upsertSubscription(
  admin: ServiceClient,
  sub: Stripe.Subscription,
  { isNew }: { isNew: boolean },
) {
  // Plan key comes from metadata set at checkout creation. No fallback — if
  // metadata is missing, something's wrong with how the sub was created.
  const planKey = sub.metadata?.plan_key;
  if (!planKey) {
    console.error(`[Stripe] No plan_key in metadata for subscription ${sub.id}`);
    return;
  }
  const plan = getPlan(planKey);
  if (!plan) {
    console.error(`[Stripe] Unknown plan_key "${planKey}" for subscription ${sub.id}`);
    return;
  }

  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? "";
  // Stripe v20 reports the actual recurring amount on the SubscriptionItem's price
  const monthlyCents = item?.price?.unit_amount ?? parseInt(sub.metadata?.monthly_cents ?? "0", 10);

  // Resolve member by Stripe customer ID
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  let { data: member } = await admin
    .from("members")
    .select("id, name, day_passes_balance")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  // Fallback: lookup by metadata.member_id (set in createApprovalCheckoutSession)
  if (!member && sub.metadata?.member_id) {
    const memberId = parseInt(sub.metadata.member_id, 10);
    if (Number.isFinite(memberId)) {
      const { data: m } = await admin
        .from("members")
        .select("id, name, day_passes_balance")
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
    console.error(`[Stripe] No member found for subscription ${sub.id} (customer ${customerId})`);
    return;
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

    // Mark application complete + announce (only first time)
    if (isNew && sub.metadata?.application_id) {
      const appId = parseInt(sub.metadata.application_id, 10);
      if (Number.isFinite(appId)) {
        await admin
          .from("applications")
          .update({ checkout_completed_at: new Date().toISOString() })
          .eq("id", appId);
      }
      const passesNote =
        member.day_passes_balance > 0
          ? ` (${member.day_passes_balance} guest passes carried forward)`
          : "";
      await notifyTelegram(
        `🎉 *New member!*\n\n*${member.name}* is now on ${planLabel(planKey)} ($${monthlyCents / 100}/mo)${passesNote}.`,
      );
    }
  }
}
