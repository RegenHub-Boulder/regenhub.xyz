import { withLockWriter } from "@regenhub/shared";
import {
  decodeEventLog,
  getAddress,
  parseAbiItem,
  type Address,
  type Hash,
  type Log,
} from "viem";
import { activateMembershipAccess, downgradeMembershipAccess } from "@/lib/membershipLifecycle";
import { getPlan, isDeskPlan } from "@/lib/plans";
import { endDeskAccessForSwitch } from "@/lib/planSwitch";
import { grantSubscriptionPasses } from "@/lib/subscriptionPasses";
import { isLiveSubscription } from "@/lib/subscriptionStatus";
import { createServiceClient } from "@/lib/supabase/admin";
import { assertOpPublicClient, getOpPublicClient } from "./config";

type ServiceClient = ReturnType<typeof createServiceClient>;
const EFFECTS_CLAIM_LEASE_MS = 5 * 60 * 1000;

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export type DecodedTransfer = {
  logIndex: number;
  from: Address;
  to: Address;
  amount: bigint;
  address: Address;
  raw: Log;
};

export function selectExpectedTransfer(
  transfers: DecodedTransfer[],
  expected: { token: string; from: string; to: string; amount: bigint },
): DecodedTransfer {
  const matches = transfers.filter(
    (transfer) =>
      transfer.address.toLowerCase() === expected.token.toLowerCase() &&
      transfer.from.toLowerCase() === expected.from.toLowerCase() &&
      transfer.to.toLowerCase() === expected.to.toLowerCase() &&
      transfer.amount === expected.amount,
  );
  if (matches.length === 0) throw new Error("transaction has no exact expected USDC transfer");
  if (matches.length > 1) throw new Error("transaction has multiple matching USDC transfers");
  return matches[0];
}

function decodeTransfers(logs: Log[]): DecodedTransfer[] {
  const transfers: DecodedTransfer[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        eventName: "Transfer",
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      transfers.push({
        logIndex: log.logIndex ?? 0,
        from: getAddress(decoded.args.from),
        to: getAddress(decoded.args.to),
        amount: decoded.args.value,
        address: getAddress(log.address),
        raw: log,
      });
    } catch {
      // Non-Transfer logs are expected in contract transactions.
    }
  }
  return transfers;
}

export function canClaimPaymentEffects(
  payment: { effects_claimed_at: string | null; effects_completed_at: string | null },
  now = new Date(),
) {
  if (payment.effects_completed_at) return false;
  if (!payment.effects_claimed_at) return true;
  return new Date(payment.effects_claimed_at).getTime() <= now.getTime() - EFFECTS_CLAIM_LEASE_MS;
}

async function completePaymentEffects(
  admin: ServiceClient,
  args: {
    paymentId: number;
    invoiceId: number;
    memberId: number;
    subscriptionId: number;
    planKey: string;
  },
) {
  const { data: payment, error: paymentError } = await admin
    .from("onchain_payments")
    .select("effects_claimed_at, effects_completed_at")
    .eq("id", args.paymentId)
    .maybeSingle();
  if (paymentError) throw paymentError;
  if (!payment || !canClaimPaymentEffects(payment)) return;

  const claimAt = new Date().toISOString();
  let claim = admin
    .from("onchain_payments")
    .update({ effects_claimed_at: claimAt })
    .eq("id", args.paymentId)
    .is("effects_completed_at", null);
  claim = payment?.effects_claimed_at
    ? claim.eq("effects_claimed_at", payment.effects_claimed_at)
    : claim.is("effects_claimed_at", null);
  const { data: claimed, error: claimError } = await claim
    .select("id")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return;

  try {
    const entitled = await withLockWriter(admin, () => reconcileOnchainAccess(admin, {
      memberId: args.memberId,
      subscriptionId: args.subscriptionId,
    }), "On-chain access reconciliation");
    if (entitled) {
      await grantSubscriptionPasses(admin, {
        memberId: args.memberId,
        subscriptionId: args.subscriptionId,
        planKey: args.planKey,
        billingEventKey: `onchain:${args.invoiceId}`,
        notifyMember: true,
      });
    }
    const { error: completeError } = await admin
      .from("onchain_payments")
      .update({ effects_claimed_at: null, effects_completed_at: new Date().toISOString() })
      .eq("id", args.paymentId)
      .eq("effects_claimed_at", claimAt)
      .is("effects_completed_at", null);
    if (completeError) throw completeError;
  } catch (error) {
    // Release the lease while retaining attempt order for fair retries, without
    // changing credited financial fields or adding a last-attempt column.
    await admin
      .from("onchain_payments")
      .update({ effects_claimed_at: new Date(Date.now() - EFFECTS_CLAIM_LEASE_MS).toISOString() })
      .eq("id", args.paymentId)
      .eq("effects_claimed_at", claimAt)
      .is("effects_completed_at", null);
    throw error;
  }
}

/**
 * Make the member's door access match the paid invoice for the period they're
 * in now. Must run under the PIN-writer reservation. Returns false, touching
 * nothing, when the subscription no longer entitles anything (an admin cancel
 * ends access under this same reservation).
 *
 * The newest paid invoice decides, so an upgrade paid ahead applies at once,
 * as before. The exception: a daily plan paid ahead doesn't end a desk period
 * that's paid for and still running. The billing cron runs this again once
 * that period is over (finishOnchainPlanSwitches).
 */
export async function reconcileOnchainAccess(
  admin: ServiceClient,
  args: { memberId: number; subscriptionId: number },
  now = new Date(),
): Promise<boolean> {
  const { data: current, error: currentError } = await admin.from("subscriptions")
    .select("status, admin_cancel_mode").eq("id", args.subscriptionId).single();
  if (currentError) throw currentError;
  if (!isLiveSubscription(current.status) || current.admin_cancel_mode === "now") return false;
  // Period order, rather than arrival/retry order, governs door access.
  const { data: latest, error: latestError } = await admin.from("onchain_invoices")
    .select("plan_key, subscriptions(plan_key)")
    .eq("member_id", args.memberId).eq("status", "paid")
    .order("period_start", { ascending: false }).order("id", { ascending: false })
    .limit(1).maybeSingle();
  if (latestError) throw latestError;
  const subscription = latest?.subscriptions as unknown as { plan_key: string } | null;
  const planKey = latest?.plan_key ?? subscription?.plan_key;
  if (!planKey) throw new Error("credited payment has no authoritative paid invoice");
  const [{ data: member }, plan] = await Promise.all([
    admin
      .from("members")
      .select("id, pin_code_slot, member_type")
      .eq("id", args.memberId)
      .single(),
    Promise.resolve(getPlan(planKey)),
  ]);
  if (!member || !plan) throw new Error("credited payment has no member or plan");

  if (plan.grantsMemberType === "day_pass" && member.pin_code_slot) {
    // A daily plan paid ahead doesn't end a desk period already paid for.
    const nowIso = now.toISOString();
    const { data: running, error: runningError } = await admin.from("onchain_invoices")
      .select("plan_key, subscriptions(plan_key)")
      .eq("member_id", args.memberId).eq("status", "paid")
      .lte("period_start", nowIso).gt("period_end", nowIso)
      .order("period_start", { ascending: false }).limit(1).maybeSingle();
    if (runningError) throw runningError;
    const runningSub = running?.subscriptions as unknown as { plan_key: string } | null;
    if (isDeskPlan(running?.plan_key ?? runningSub?.plan_key)) return true;
    // A desk period ending for a daily plan is a plan switch landing: audited, through the same lifecycle.
    const revoked = member.member_type === "cold_desk" || member.member_type === "hot_desk"
      ? await endDeskAccessForSwitch(admin, {
        subscriptionId: args.subscriptionId, memberId: member.id, rail: "onchain", from: member.member_type, to: planKey,
      })
      : await downgradeMembershipAccess(admin, { memberId: member.id, currentPinSlot: member.pin_code_slot, revokePermanentPin: true });
    if (revoked.lockRevokeFailed || ("memberUpdateError" in revoked && revoked.memberUpdateError)) {
      throw new Error("Could not revoke permanent door access");
    }
  }
  const activation = await activateMembershipAccess(admin, {
    memberId: member.id,
    currentPinSlot: member.pin_code_slot,
    grantsMemberType: plan.grantsMemberType,
  });
  if (activation.autoAllocationFailure) throw new Error(activation.autoAllocationFailure);
  return true;
}

/**
 * On-chain counterpart of the Stripe webhook landing a desk → daily switch:
 * once the period of a paid daily-plan invoice starts, end the desk access of
 * a member who switched. Called from the on-chain billing cron; a failure is
 * retried on the next run (a failed lock clear is quarantined for Lock Sync).
 */
export async function finishOnchainPlanSwitches(admin: ServiceClient, now = new Date()) {
  const { data: subs, error } = await admin.from("subscriptions")
    .select("id, member_id, plan_key")
    .eq("payment_rail", "onchain")
    .in("status", ["active", "trialing", "past_due"])
    .is("admin_cancel_mode", null);
  if (error) throw error;
  const results: { subscriptionId: number; memberId: number; error?: string }[] = [];
  for (const sub of (subs ?? []) as { id: number; member_id: number; plan_key: string }[]) {
    if (isDeskPlan(sub.plan_key)) continue;
    const { data: member, error: memberError } = await admin.from("members")
      .select("member_type").eq("id", sub.member_id).maybeSingle();
    if (memberError) throw memberError;
    if (member?.member_type !== "cold_desk" && member?.member_type !== "hot_desk") continue;
    try {
      await withLockWriter(admin, () => reconcileOnchainAccess(admin, { memberId: sub.member_id, subscriptionId: sub.id }, now),
        "On-chain plan switch");
      results.push({ subscriptionId: sub.id, memberId: sub.member_id });
    } catch (cause) {
      console.error(`[OnchainBilling] Plan switch for subscription ${sub.id} failed:`, cause);
      results.push({ subscriptionId: sub.id, memberId: sub.member_id, error: cause instanceof Error ? cause.message : "unknown" });
    }
  }
  return results;
}

export type ProcessInvoiceResult =
  | { status: "submitted" | "detected"; txHash: string }
  | { status: "paid"; txHash: string; paymentId: number; wasNew: boolean }
  | { status: "exception"; txHash: string; reason: string };

/** Verify one submitted transaction and credit its exact successful OP receipt. */
export async function processOnchainInvoice(
  admin: ServiceClient,
  invoiceId: number,
): Promise<ProcessInvoiceResult> {
  const { data: invoice, error: invoiceError } = await admin
    .from("onchain_invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();
  if (invoiceError || !invoice?.submitted_tx_hash) throw new Error("submitted invoice not found");

  const { data: subscription } = await admin
    .from("subscriptions")
    .select("id, member_id, wallet_id, plan_key")
    .eq("id", invoice.subscription_id)
    .eq("payment_rail", "onchain")
    .single();
  if (!subscription?.wallet_id) throw new Error("invoice subscription has no verified wallet");
  const { data: relayJob, error: relayJobError } = await admin
    .from("onchain_relay_jobs")
    .select("member_id, from_address")
    .eq("invoice_id", invoice.id)
    .eq("submitted_tx_hash", invoice.submitted_tx_hash)
    .maybeSingle();
  if (relayJobError) throw relayJobError;
  let expectedSender = relayJob?.from_address ?? null;
  if (relayJob && relayJob.member_id !== subscription.member_id) {
    throw new Error("relay authorization belongs to another member");
  }
  if (!expectedSender) {
    const { data: wallet } = await admin
      .from("member_wallets")
      .select("address")
      .eq("id", subscription.wallet_id)
      .is("revoked_at", null)
      .single();
    if (!wallet) throw new Error("verified wallet not found");
    expectedSender = wallet.address;
  }

  const txHash = invoice.submitted_tx_hash as Hash;
  const client = getOpPublicClient();
  await assertOpPublicClient(client);
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    if (error instanceof Error && /not found|could not be found/i.test(error.message)) {
      return { status: "submitted", txHash };
    }
    throw error;
  }

  if (receipt.status !== "success") {
    const reason = "transaction reverted";
    await admin
      .from("onchain_invoices")
      .update({
        status: "exception",
        exception_reason: reason,
        submitted_tx_hash: null,
        submitted_at: null,
      })
      .eq("id", invoice.id);
    await admin
      .from("onchain_relay_jobs")
      .update({
        status: "signed",
        submitted_tx_hash: null,
        submitted_at: null,
        last_error: reason,
      })
      .eq("invoice_id", invoice.id)
      .eq("submitted_tx_hash", txHash);
    return { status: "exception", txHash, reason };
  }

  let transfer: DecodedTransfer;
  try {
    transfer = selectExpectedTransfer(decodeTransfers(receipt.logs), {
      token: invoice.token_contract,
      from: expectedSender,
      to: invoice.treasury_address,
      amount: BigInt(invoice.amount_usdc_micros),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "payment did not match invoice";
    await admin
      .from("onchain_invoices")
      .update({
        status: "exception",
        exception_reason: reason,
        submitted_tx_hash: null,
        submitted_at: null,
        detected_at: new Date().toISOString(),
      })
      .eq("id", invoice.id);
    await admin
      .from("onchain_relay_jobs")
      .update({ status: "expired", last_error: reason })
      .eq("invoice_id", invoice.id)
      .eq("submitted_tx_hash", txHash);
    return { status: "exception", txHash, reason };
  }

  const rawLog = {
    address: transfer.raw.address,
    blockHash: transfer.raw.blockHash,
    blockNumber: transfer.raw.blockNumber?.toString() ?? null,
    data: transfer.raw.data,
    logIndex: transfer.raw.logIndex,
    topics: transfer.raw.topics,
    transactionHash: transfer.raw.transactionHash,
  };
  const { data: creditRows, error: creditError } = await admin.rpc("credit_onchain_invoice", {
    p_invoice_id: invoice.id,
    p_tx_hash: txHash,
    p_log_index: transfer.logIndex,
    p_block_number: Number(receipt.blockNumber),
    p_block_hash: receipt.blockHash,
    p_from_address: transfer.from,
    p_to_address: transfer.to,
    p_token_contract: transfer.address,
    p_amount_micros: Number(transfer.amount),
    p_chain_status: "included",
    p_raw_log: rawLog,
  });
  if (creditError) throw creditError;
  const credit = creditRows?.[0];
  if (!credit) throw new Error("credit RPC returned no payment");
  if (credit.match_status === "exception") {
    // Paid after an admin canceled: recorded for reconciliation, not credited.
    return { status: "exception", txHash, reason: "membership was canceled; payment recorded for an admin to reconcile" };
  }

  await completePaymentEffects(admin, {
    paymentId: credit.payment_id,
    invoiceId: invoice.id,
    memberId: credit.member_id,
    subscriptionId: credit.subscription_id,
    planKey: credit.plan_key,
  });
  return { status: "paid", txHash, paymentId: credit.payment_id, wasNew: credit.was_new };
}

/** Retry post-credit effects that failed after the financial transaction committed. */
export async function retryPendingOnchainEffects(admin: ServiceClient) {
  const { data: pending, error } = await admin
    .from("onchain_payments")
    .select("id, invoice_id, member_id, onchain_invoices(subscription_id, plan_key, subscriptions(plan_key))")
    .eq("match_status", "credited")
    .is("effects_completed_at", null)
    .order("effects_claimed_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(50);
  if (error) throw error;
  const failures: { paymentId: number; error: string }[] = [];
  for (const payment of pending ?? []) {
    const invoice = payment.onchain_invoices as unknown as {
      subscription_id: number;
      plan_key?: string | null;
      subscriptions: { plan_key: string } | null;
    } | null;
    if (!invoice?.subscriptions) continue;
    try {
      await completePaymentEffects(admin, {
        paymentId: payment.id,
        invoiceId: payment.invoice_id,
        memberId: payment.member_id,
        subscriptionId: invoice.subscription_id,
        planKey: invoice.plan_key ?? invoice.subscriptions.plan_key,
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      console.error(`[OnchainBilling] Payment ${payment.id} effects failed:`, cause);
      failures.push({ paymentId: payment.id, error });
    }
  }
  return failures;
}

/** Mark included/safe credits finalized once OP's finalized head passes them. */
export async function advanceFinalizedOnchainPayments(admin: ServiceClient) {
  const client = getOpPublicClient();
  await assertOpPublicClient(client);
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const { data, error } = await admin
    .from("onchain_payments")
    .select("id, block_number, block_hash")
    .in("chain_status", ["included", "safe"])
    .lte("block_number", Number(finalized.number))
    .limit(100);
  if (error) throw error;
  let advanced = 0;
  for (const payment of data ?? []) {
    const canonical = await client.getBlock({ blockNumber: BigInt(payment.block_number) });
    if (canonical.hash.toLowerCase() !== payment.block_hash.toLowerCase()) {
      await admin.from("onchain_payments").update({ chain_status: "reorged", exception_reason: "credited block is no longer canonical" }).eq("id", payment.id);
      console.error(`[OnchainBilling] Credited payment ${payment.id} was reorged before finalization`);
      continue;
    }
    await admin.from("onchain_payments").update({ chain_status: "finalized" }).eq("id", payment.id);
    advanced += 1;
  }
  return advanced;
}
