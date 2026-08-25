import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import { resolveSubscriptionNet } from "@/lib/stripeRetrieveNet";

/**
 * Backfill subscriptions.net_cents from live Stripe discounts.
 * Webhooks write this going forward; this catches rows created before
 * the column existed (or any retrieve that failed at webhook time).
 */
export async function POST() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }

  const admin = createServiceClient();
  const { data: rows, error } = await admin
    .from("subscriptions")
    .select("id, stripe_subscription_id, monthly_cents")
    .in("status", ["active", "trialing", "past_due"]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const stripe = getStripe();
  let updated = 0;
  const failed: { id: string; error: string }[] = [];

  for (const row of rows ?? []) {
    try {
      const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id, {
        expand: ["discounts.source.coupon", "discounts.promotion_code"],
      });
      const net = await resolveSubscriptionNet(sub, row.monthly_cents);
      const patch: {
        net_cents: number | null;
        discount_cents?: number | null;
        discount_duration?: "forever" | "repeating" | null;
        discount_months?: number | null;
        discount_note?: string | null;
      } = { net_cents: net.netCents };
      if (net.offCents != null && net.offCents > 0) {
        patch.discount_cents = net.offCents;
        patch.discount_duration = net.duration === "once" ? null : net.duration;
        patch.discount_months = net.durationMonths;
        patch.discount_note = net.note;
      }
      const { error: upErr } = await admin
        .from("subscriptions")
        .update(patch)
        .eq("id", row.id);
      if (upErr) {
        failed.push({ id: row.stripe_subscription_id, error: upErr.message });
      } else {
        updated += 1;
      }
    } catch (err) {
      failed.push({
        id: row.stripe_subscription_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    scanned: (rows ?? []).length,
    updated,
    failed,
  });
}
