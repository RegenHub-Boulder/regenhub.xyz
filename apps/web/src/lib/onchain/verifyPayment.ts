import {
  decodeEventLog,
  getAddress,
  parseAbiItem,
  type Address,
  type Hash,
  type Log,
} from "viem";
import { activateMembershipAccess } from "@/lib/membershipLifecycle";
import { getPlan } from "@/lib/plans";
import { grantSubscriptionPasses } from "@/lib/subscriptionPasses";
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
    const [{ data: member }, plan] = await Promise.all([
      admin
        .from("members")
        .select("id, pin_code_slot")
        .eq("id", args.memberId)
        .single(),
      Promise.resolve(getPlan(args.planKey)),
    ]);
    if (!member || !plan) throw new Error("credited payment has no member or plan");

    await activateMembershipAccess(admin, {
      memberId: member.id,
      currentPinSlot: member.pin_code_slot,
      grantsMemberType: plan.grantsMemberType,
    });
    await grantSubscriptionPasses(admin, {
      memberId: member.id,
      subscriptionId: args.subscriptionId,
      planKey: args.planKey,
      billingEventKey: `onchain:${args.invoiceId}`,
      notifyMember: true,
    });
    const { error: completeError } = await admin
      .from("onchain_payments")
      .update({ effects_claimed_at: null, effects_completed_at: new Date().toISOString() })
      .eq("id", args.paymentId)
      .eq("effects_claimed_at", claimAt)
      .is("effects_completed_at", null);
    if (completeError) throw completeError;
  } catch (error) {
    await admin
      .from("onchain_payments")
      .update({ effects_claimed_at: null })
      .eq("id", args.paymentId)
      .eq("effects_claimed_at", claimAt)
      .is("effects_completed_at", null);
    throw error;
  }
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
    .select("id, invoice_id, member_id, onchain_invoices(subscription_id, subscriptions(plan_key))")
    .eq("match_status", "credited")
    .is("effects_completed_at", null)
    .limit(50);
  if (error) throw error;
  for (const payment of pending ?? []) {
    const invoice = payment.onchain_invoices as unknown as {
      subscription_id: number;
      subscriptions: { plan_key: string } | null;
    } | null;
    if (!invoice?.subscriptions) continue;
    await completePaymentEffects(admin, {
      paymentId: payment.id,
      invoiceId: payment.invoice_id,
      memberId: payment.member_id,
      subscriptionId: invoice.subscription_id,
      planKey: invoice.subscriptions.plan_key,
    });
  }
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
