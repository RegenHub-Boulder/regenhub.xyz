import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { discountedCents, generateUpcomingOnchainInvoices } from "@/lib/onchain/invoice";
import { activateMembershipAccess } from "@/lib/membershipLifecycle";
import { getPlan } from "@/lib/plans";
import { AuditAction, logAction } from "@/lib/auditLog";

type Body = {
  plan_key?: string;
  monthly_cents?: number;
  wallet_address?: string;
  paid_through?: string;
};

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceClient();
  const { data: actor } = await admin
    .from("members")
    .select("id, is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!actor?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const memberId = Number.parseInt((await ctx.params).id, 10);
  const body = (await req.json().catch(() => null)) as Body | null;
  const plan = body?.plan_key ? getPlan(body.plan_key) : null;
  const monthlyCents = body?.monthly_cents;
  const paidThrough = body?.paid_through ? new Date(body.paid_through) : null;
  if (!memberId || !plan || !Number.isInteger(monthlyCents) || (monthlyCents ?? 0) < 100) {
    return NextResponse.json({ error: "Valid member, plan, and monthly amount are required" }, { status: 400 });
  }
  if (!body?.wallet_address || !isAddress(body.wallet_address)) {
    return NextResponse.json({ error: "A valid EVM wallet address is required" }, { status: 400 });
  }
  if (!paidThrough || Number.isNaN(paidThrough.getTime())) {
    return NextResponse.json({ error: "A valid paid-through date is required" }, { status: 400 });
  }

  const { data: member } = await admin
    .from("members")
    .select("id, pin_code_slot")
    .eq("id", memberId)
    .single();
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const { data: existing } = await admin
    .from("subscriptions")
    .select("id")
    .eq("member_id", memberId)
    .in("status", ["active", "trialing", "past_due", "incomplete"])
    .limit(1)
    .maybeSingle();
  if (existing) return NextResponse.json({ error: "Member already has a live subscription" }, { status: 409 });

  const address = getAddress(body.wallet_address);
  const { data: walletId, error: walletError } = await admin.rpc("bind_member_wallet", {
    p_member_id: memberId,
    p_address: address,
    p_verification_method: "admin_prior_payment",
    p_verified_by: actor.id,
  });
  if (walletError || !walletId) {
    return NextResponse.json({ error: walletError?.message ?? "Could not bind wallet" }, { status: 400 });
  }

  const now = new Date();
  const isPastDue = paidThrough.getTime() <= now.getTime();
  const { data: subscription, error: subscriptionError } = await admin
    .from("subscriptions")
    .insert({
      member_id: memberId,
      payment_rail: "onchain",
      wallet_id: walletId,
      stripe_subscription_id: null,
      stripe_customer_id: null,
      stripe_price_id: null,
      plan_key: body.plan_key!,
      monthly_cents: monthlyCents!,
      net_cents: discountedCents(monthlyCents!),
      status: isPastDue ? "past_due" : "active",
      current_period_end: paidThrough.toISOString(),
      past_due_since: isPastDue ? now.toISOString() : null,
      cancel_at_period_end: false,
    })
    .select("*")
    .single();
  if (subscriptionError || !subscription) {
    return NextResponse.json({ error: subscriptionError?.message ?? "Could not create subscription" }, { status: 400 });
  }

  await activateMembershipAccess(admin, {
    memberId,
    currentPinSlot: member.pin_code_slot,
    grantsMemberType: plan.grantsMemberType,
  });
  const invoices = await generateUpcomingOnchainInvoices(admin);
  await logAction({
    action: AuditAction.ONCHAIN_SUBSCRIPTION_CREATED,
    actorMemberId: actor.id,
    target: { table: "subscriptions", id: subscription.id },
    payload: { member_id: memberId, plan_key: body.plan_key, monthly_cents: monthlyCents, wallet: address },
  }, admin);

  return NextResponse.json({ subscription, wallet_id: walletId, invoices_created: invoices.length });
}
