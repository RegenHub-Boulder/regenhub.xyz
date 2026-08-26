import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { discountedCents, invoiceValues } from "@/lib/onchain/invoice";
import { getPlan } from "@/lib/plans";
import type { PlanKey } from "@/lib/supabase/types";
import { AuditAction, logAction } from "@/lib/auditLog";

type Body = { plan_key?: PlanKey };

/**
 * Start a first-time direct-USDC membership after the member has signature-
 * verified a wallet. Access remains unchanged until the initial invoice is
 * actually paid and credited by the normal on-chain verifier.
 */
export async function POST(request: Request) {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null) as Body | null;
  const plan = body?.plan_key ? getPlan(body.plan_key) : null;
  if (!body?.plan_key || !plan?.selfServe) {
    return NextResponse.json({ error: "Unknown membership plan" }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: member, error: memberError } = await admin
    .from("members")
    .select("id, approved_for_daily, approved_for_full")
    .eq("id", session.member.id)
    .single();
  if (memberError || !member) {
    return NextResponse.json({ error: "Couldn't look up your membership." }, { status: 500 });
  }

  const isDeskTier = plan.grantsMemberType === "hot_desk" || plan.grantsMemberType === "cold_desk";
  if ((isDeskTier && !member.approved_for_full) || (!isDeskTier && !member.approved_for_daily)) {
    return NextResponse.json(
      { error: isDeskTier ? "Full Access has not been approved yet." : "Membership has not been approved yet." },
      { status: 403 },
    );
  }

  const { data: existing, error: existingError } = await admin
    .from("subscriptions")
    .select("id, payment_rail")
    .eq("member_id", member.id)
    .in("status", ["active", "trialing", "past_due", "incomplete"])
    .limit(1)
    .maybeSingle();
  if (existingError) {
    return NextResponse.json({ error: "Couldn't check your membership." }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json(
      { error: existing.payment_rail === "onchain" ? "Your crypto membership is already set up. Open the portal to continue." : "You already have a live membership." },
      { status: 409 },
    );
  }

  const { data: wallet, error: walletError } = await admin
    .from("member_wallets")
    .select("id, address")
    .eq("member_id", member.id)
    .eq("verification_method", "signature")
    .is("revoked_at", null)
    .maybeSingle();
  if (walletError) {
    return NextResponse.json({ error: "Couldn't look up your verified wallet." }, { status: 500 });
  }
  if (!wallet) {
    return NextResponse.json({ error: "Connect and verify a wallet first." }, { status: 409 });
  }

  // Honor the admin-approved rate when this is the plan from the application;
  // otherwise use the catalog rate, matching the existing self-serve Stripe path.
  const { data: application } = await admin
    .from("applications")
    .select("status, approved_plan_key, approved_monthly_cents")
    .eq("supabase_user_id", session.user.id)
    .maybeSingle();
  const approvedCents = application?.status === "approved" &&
    application.approved_plan_key === body.plan_key &&
    Number.isInteger(application.approved_monthly_cents) &&
    application.approved_monthly_cents > 0
    ? application.approved_monthly_cents
    : null;
  const monthlyCents = approvedCents ?? plan.defaultMonthlyCents;
  const periodStart = new Date().toISOString();

  const { data: subscription, error: subscriptionError } = await admin
    .from("subscriptions")
    .insert({
      member_id: member.id,
      payment_rail: "onchain",
      wallet_id: wallet.id,
      stripe_subscription_id: null,
      stripe_customer_id: null,
      stripe_price_id: null,
      plan_key: body.plan_key,
      monthly_cents: monthlyCents,
      net_cents: discountedCents(monthlyCents),
      status: "incomplete",
      current_period_end: periodStart,
      cancel_at_period_end: false,
    })
    .select("*")
    .single();
  if (subscriptionError || !subscription) {
    return NextResponse.json(
      { error: subscriptionError?.message ?? "Could not start crypto membership" },
      { status: subscriptionError?.code === "23505" ? 409 : 400 },
    );
  }

  const initialInvoice = invoiceValues({
    subscriptionId: subscription.id,
    memberId: member.id,
    periodStart,
    baseAmountCents: monthlyCents,
  });
  const { data: invoice, error: invoiceError } = await admin
    .from("onchain_invoices")
    .insert(initialInvoice)
    .select("id, amount_cents, amount_usdc_micros, due_at, status")
    .single();
  if (invoiceError || !invoice) {
    // No money or access has moved yet. Remove the incomplete shell so the
    // member can retry instead of getting stuck behind the live-sub guard.
    await admin.from("subscriptions").delete().eq("id", subscription.id).eq("status", "incomplete");
    console.error("[OnchainSignup] Initial invoice insert failed:", invoiceError);
    return NextResponse.json({ error: "Could not create the first crypto invoice" }, { status: 500 });
  }

  await logAction({
    action: AuditAction.ONCHAIN_SUBSCRIPTION_CREATED,
    actorMemberId: member.id,
    target: { table: "subscriptions", id: subscription.id },
    payload: { member_id: member.id, plan_key: body.plan_key, monthly_cents: monthlyCents, wallet: wallet.address, source: "self_serve" },
  }, admin);

  return NextResponse.json({ subscription_id: subscription.id, invoice });
}
