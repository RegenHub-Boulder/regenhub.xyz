import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { discountedCents, invoiceValues } from "@/lib/onchain/invoice";
import {
  NATIVE_USDC_ADDRESS,
  ONCHAIN_CHAIN_ID,
  TREASURY_ADDRESS,
} from "@/lib/onchain/config";
import { getPlan } from "@/lib/plans";
import type { PlanKey } from "@/lib/supabase/types";
import { AuditAction, logAction } from "@/lib/auditLog";

type Body = { plan_key?: PlanKey };

function setupResponse(subscriptionId: number, invoice: {
  id: number;
  amount_cents: number;
  amount_usdc_micros: number;
  due_at: string;
  status: string;
  submitted_tx_hash?: string | null;
}) {
  return {
    subscription_id: subscriptionId,
    invoice,
    payment: {
      chain_id: ONCHAIN_CHAIN_ID,
      token_address: NATIVE_USDC_ADDRESS,
      treasury_address: TREASURY_ADDRESS,
    },
  };
}

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
    .select("id, payment_rail, plan_key, status")
    .eq("member_id", member.id)
    .in("status", ["active", "trialing", "past_due", "incomplete"])
    .limit(1)
    .maybeSingle();
  if (existingError) {
    return NextResponse.json({ error: "Couldn't check your membership." }, { status: 500 });
  }
  if (existing && (existing.payment_rail !== "onchain" || existing.status !== "incomplete")) {
    return NextResponse.json(
      { error: existing?.payment_rail === "onchain" ? "Your crypto membership is already set up. Open the portal to continue." : "You already have a live membership." },
      { status: 409 },
    );
  }

  if (existing && existing.plan_key !== body.plan_key) {
    return NextResponse.json(
      { error: "Your existing crypto setup uses a different membership plan. Open the portal to continue." },
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

  // A rejected wallet prompt or closed browser must not strand the member.
  // Resume the same unpaid setup rather than creating another invoice.
  if (existing) {
    const { data: invoice, error: invoiceError } = await admin
      .from("onchain_invoices")
      .select("id, amount_cents, amount_usdc_micros, due_at, status, submitted_tx_hash")
      .eq("subscription_id", existing.id)
      .in("status", ["open", "submitted", "detected"])
      .maybeSingle();
    if (invoiceError || !invoice) {
      return NextResponse.json({ error: "Could not resume your first crypto invoice. Open the portal to continue." }, { status: 409 });
    }
    return NextResponse.json(setupResponse(existing.id, invoice));
  }

  // Self-serve prices must come from server-owned catalog data. Application
  // rows contain admin workflow fields and must never be a billing authority.
  const monthlyCents = plan.defaultMonthlyCents;
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
    console.error("[OnchainSignup] Subscription insert failed:", subscriptionError);
    return NextResponse.json(
      { error: subscriptionError?.code === "23505" ? "Your crypto membership is already set up." : "Could not start crypto membership" },
      { status: subscriptionError?.code === "23505" ? 409 : 500 },
    );
  }

  const initialInvoice = invoiceValues({
    subscriptionId: subscription.id,
    memberId: member.id,
    periodStart,
    baseAmountCents: monthlyCents,
    dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const { data: invoice, error: invoiceError } = await admin
    .from("onchain_invoices")
    .insert(initialInvoice)
    .select("id, amount_cents, amount_usdc_micros, due_at, status, submitted_tx_hash")
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

  return NextResponse.json(setupResponse(subscription.id, invoice));
}
