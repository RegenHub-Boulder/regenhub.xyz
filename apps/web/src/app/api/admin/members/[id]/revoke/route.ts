import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

interface RevokeBody {
  refund_last_purchase?: boolean;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: adminMember } = await supabase
    .from("members")
    .select("is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!adminMember?.is_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: idParam } = await ctx.params;
  const memberId = parseInt(idParam, 10);
  if (!memberId) {
    return NextResponse.json({ error: "Invalid member id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as RevokeBody | null;
  const admin = createServiceClient();

  const { data: member, error: memberErr } = await admin
    .from("members")
    .select("id, name")
    .eq("id", memberId)
    .single();
  if (memberErr || !member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  await admin.from("members").update({ disabled: true }).eq("id", memberId);

  // Cancel any active Stripe subscriptions immediately. They keep paying
  // otherwise, which is bad. Failures here don't roll back the revoke —
  // member is still disabled; admin gets a warning to clean up in Stripe.
  const canceledSubs: string[] = [];
  const cancelErrors: { stripe_subscription_id: string; error: string }[] = [];
  if (isStripeConfigured()) {
    const { data: liveSubs } = await admin
      .from("subscriptions")
      .select("id, stripe_subscription_id")
      .eq("member_id", memberId)
      .in("status", ["active", "trialing", "past_due", "incomplete"]);
    for (const sub of liveSubs ?? []) {
      try {
        await getStripe().subscriptions.cancel(sub.stripe_subscription_id);
        // Local mirror updates via the customer.subscription.deleted webhook,
        // but stamp it here too in case the webhook is delayed.
        await admin
          .from("subscriptions")
          .update({ status: "canceled", canceled_at: new Date().toISOString() })
          .eq("id", sub.id);
        canceledSubs.push(sub.stripe_subscription_id);
      } catch (err) {
        console.error("[RevokeMember] Stripe cancel failed:", err);
        cancelErrors.push({
          stripe_subscription_id: sub.stripe_subscription_id,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  }

  let refunded: { amount: number; refund_id: string } | null = null;
  if (body?.refund_last_purchase && isStripeConfigured()) {
    const { data: lastPurchase } = await admin
      .from("purchases")
      .select("id, stripe_payment_intent, amount_cents")
      .eq("member_id", memberId)
      .not("stripe_payment_intent", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastPurchase?.stripe_payment_intent) {
      try {
        const refund = await getStripe().refunds.create({
          payment_intent: lastPurchase.stripe_payment_intent,
        });
        refunded = { amount: lastPurchase.amount_cents, refund_id: refund.id };
      } catch (err) {
        console.error("[RevokeMember] Refund failed:", err);
        // Don't fail the whole revoke if refund fails — member is still disabled.
        return NextResponse.json({
          revoked: true,
          canceled_subscriptions: canceledSubs,
          cancel_errors: cancelErrors,
          refund_error: err instanceof Error ? err.message : "Refund failed",
        });
      }
    }
  }

  return NextResponse.json({
    revoked: true,
    canceled_subscriptions: canceledSubs,
    cancel_errors: cancelErrors,
    refunded,
  });
}
