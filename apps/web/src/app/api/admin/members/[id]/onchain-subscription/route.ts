import { resolveOnchainCoupon } from "@/lib/onchain/discount";
import { onchainChangeMessage, onchainSwitchColumns } from "@/lib/planSwitch";
import { requireAdmin, requireAdminMember } from "@/lib/admin";
import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
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
  const auth = await requireAdminMember();
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const actor = auth.member;

  const admin = createServiceClient();

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

  const activation = await activateMembershipAccess(admin, {
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

  return NextResponse.json({ subscription, wallet_id: walletId, invoices_created: invoices.length, access_warning: activation.autoAllocationFailure });
}

/** Prospective edits only: invoice trigger serializes and snapshots issuance. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const memberId = Number((await ctx.params).id);
  const body = await req.json().catch(() => null) as { plan_key?: string; discount_code?: string } | null;
  if (!Number.isInteger(memberId) || !body || (!body.plan_key && body.discount_code === undefined)) return NextResponse.json({ error: "Plan or discount code required" }, { status: 400 });
  const admin = createServiceClient();
  const { data: actor } = await admin.from("members").select("id").eq("supabase_user_id", user.id).single();
  const { data: sub } = await admin.from("subscriptions").select("id, plan_key, current_period_end, pending_plan_key, pending_plan_at, pending_plan_from")
    .eq("member_id", memberId).eq("payment_rail", "onchain").in("status", ["active", "trialing", "past_due"]).maybeSingle();
  if (!sub) return NextResponse.json({ error: "Active crypto membership not found" }, { status: 404 });
  const plan = body.plan_key ? getPlan(body.plan_key) : null;
  if (body.plan_key && !plan) return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  const changes: import("@/lib/supabase/types").Database["public"]["Tables"]["subscriptions"]["Update"] = {};
  const switchColumns = plan && body.plan_key ? onchainSwitchColumns(sub, body.plan_key) : {};
  if (plan && body.plan_key) {
    // Desk → daily: the member keeps the desk until its paid period ends (lib/planSwitch.ts).
    Object.assign(changes, { plan_key: body.plan_key, monthly_cents: plan.defaultMonthlyCents }, switchColumns);
  }
  if (body.discount_code !== undefined) {
    try { changes.onchain_coupon = body.discount_code.trim() ? await resolveOnchainCoupon(body.discount_code, body.plan_key ?? sub.plan_key) : null; }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid code" }, { status: 400 }); }
  }
  const { error } = await admin.from("subscriptions").update(changes).eq("id", sub.id).eq("payment_rail", "onchain").in("status", ["active", "trialing", "past_due"]);
  if (error) return NextResponse.json({ error: "Could not update membership" }, { status: 500 });
  await logAction({ action: AuditAction.ONCHAIN_SUBSCRIPTION_CHANGED, actorMemberId: actor?.id, target: { table: "subscriptions", id: sub.id }, payload: { member_id: memberId, from: sub.plan_key, ...changes } }, admin);
  return NextResponse.json({ ok: true, message: body.plan_key ? onchainChangeMessage(switchColumns, body.plan_key) : "Discount saved for the next invoice. Issued invoices keep their price." });
}
