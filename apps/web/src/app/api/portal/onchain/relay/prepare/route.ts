import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getAddress, parseAbi } from "viem";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  assertOpPublicClient,
  getOpPublicClient,
  isGaslessRelayConfigured,
  NATIVE_USDC_ADDRESS,
  ONCHAIN_CHAIN_ID,
  TREASURY_ADDRESS,
} from "@/lib/onchain/config";
import { publicAuthorization, type RelayJob } from "@/lib/onchain/gaslessRelay";
import { requirePortalMember } from "@/lib/onchain/portalMember";

const AUTHORIZATION_LIFETIME_SECONDS = 30 * 60;
const USDC_BALANCE_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

function formatUsdcMicros(value: bigint) {
  const microsPerUsdc = BigInt(1_000_000);
  const whole = value / microsPerUsdc;
  const fraction = (value % microsPerUsdc).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function responseForJob(job: RelayJob) {
  if (job.status === "submitted" && job.submitted_tx_hash) {
    return { status: "submitted", txHash: job.submitted_tx_hash };
  }
  if (["signed", "submitting"].includes(job.status)) {
    return { status: "queued" };
  }
  return { status: "prepared", authorization: publicAuthorization(job) };
}

export async function POST(request: Request) {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isGaslessRelayConfigured()) {
    return NextResponse.json({ error: "Gasless USDC payments are not configured" }, { status: 503 });
  }
  const body = await request.json().catch(() => null) as { invoice_id?: number } | null;
  if (!Number.isInteger(body?.invoice_id) || (body?.invoice_id ?? 0) <= 0) {
    return NextResponse.json({ error: "Valid invoice required" }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: invoice, error: invoiceError } = await admin
    .from("onchain_invoices")
    .select("id, member_id, subscription_id, status, submitted_tx_hash, amount_usdc_micros, chain_id, token_contract, treasury_address")
    .eq("id", body!.invoice_id!)
    .eq("member_id", session.member.id)
    .maybeSingle();
  if (invoiceError) {
    console.error("[GaslessRelay] Invoice lookup failed:", invoiceError);
    return NextResponse.json({ error: "Could not prepare the payment" }, { status: 500 });
  }
  if (!invoice || !["open", "exception", "submitted", "detected"].includes(invoice.status)) {
    return NextResponse.json({ error: "Open invoice not found" }, { status: 404 });
  }
  if (
    invoice.chain_id !== ONCHAIN_CHAIN_ID
    || invoice.token_contract.toLowerCase() !== NATIVE_USDC_ADDRESS.toLowerCase()
    || invoice.treasury_address.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()
  ) {
    console.error(`[GaslessRelay] Invoice ${invoice.id} does not match configured OP payment rail`);
    return NextResponse.json({ error: "Invoice payment details are not valid" }, { status: 409 });
  }
  if (invoice.submitted_tx_hash) {
    return NextResponse.json({ status: "submitted", txHash: invoice.submitted_tx_hash });
  }

  const { data: subscription } = await admin
    .from("subscriptions")
    .select("wallet_id, payment_rail")
    .eq("id", invoice.subscription_id)
    .eq("member_id", session.member.id)
    .eq("payment_rail", "onchain")
    .single();
  if (!subscription?.wallet_id) {
    return NextResponse.json({ error: "Verified payment wallet not found" }, { status: 409 });
  }
  const { data: wallet } = await admin
    .from("member_wallets")
    .select("address")
    .eq("id", subscription.wallet_id)
    .eq("member_id", session.member.id)
    .eq("verification_method", "signature")
    .is("revoked_at", null)
    .single();
  if (!wallet) {
    return NextResponse.json({ error: "Connect and verify a wallet first" }, { status: 409 });
  }

  const now = Math.floor(Date.now() / 1000);
  const { data: existing, error: existingError } = await admin
    .from("onchain_relay_jobs")
    .select("*")
    .eq("invoice_id", invoice.id)
    .maybeSingle();
  if (existingError) {
    console.error("[GaslessRelay] Job lookup failed:", existingError);
    return NextResponse.json({ error: "Could not prepare the payment" }, { status: 500 });
  }
  if (existing) {
    if (["signed", "submitting", "submitted"].includes(existing.status)) {
      return NextResponse.json(responseForJob(existing));
    }
  }

  let authorizationFromBlock: number;
  try {
    const client = getOpPublicClient();
    await assertOpPublicClient(client);
    const observedBlock = await client.getBlockNumber();
    const balance = await client.readContract({
      address: NATIVE_USDC_ADDRESS,
      abi: USDC_BALANCE_ABI,
      functionName: "balanceOf",
      args: [getAddress(wallet.address)],
      blockNumber: observedBlock,
    });
    const required = BigInt(invoice.amount_usdc_micros);
    if (balance < required) {
      const shortfall = required - balance;
      return NextResponse.json({
        error: `This wallet has ${formatUsdcMicros(balance)} native USDC on OP Mainnet, but this payment requires ${formatUsdcMicros(required)}. Add ${formatUsdcMicros(shortfall)} USDC to this wallet before authorizing.`,
        code: "insufficient_usdc_balance",
        balance_usdc_micros: balance.toString(),
        required_usdc_micros: required.toString(),
        shortfall_usdc_micros: shortfall.toString(),
      }, { status: 409 });
    }
    authorizationFromBlock = Number(observedBlock);
  } catch (error) {
    console.error("[GaslessRelay] Could not verify wallet balance:", error);
    return NextResponse.json({ error: "Could not verify the wallet's OP USDC balance" }, { status: 503 });
  }

  if (existing?.status === "prepared" && existing.valid_before > now + 30) {
    return NextResponse.json(responseForJob(existing));
  }

  const values = {
    invoice_id: invoice.id,
    member_id: session.member.id,
    wallet_id: subscription.wallet_id,
    from_address: wallet.address.toLowerCase(),
    token_contract: invoice.token_contract,
    treasury_address: invoice.treasury_address,
    amount_usdc_micros: invoice.amount_usdc_micros,
    authorization_nonce: `0x${randomBytes(32).toString("hex")}`,
    valid_after: Math.max(0, now - 60),
    valid_before: now + AUTHORIZATION_LIFETIME_SECONDS,
    signature: null,
    status: "prepared" as const,
    authorization_from_block: authorizationFromBlock,
    submitted_tx_hash: null,
    attempts: 0,
    last_error: null,
    signed_at: null,
    submitted_at: null,
  };
  const { data: job, error: upsertError } = await admin
    .from("onchain_relay_jobs")
    .upsert(values, { onConflict: "invoice_id" })
    .select("*")
    .single();
  if (upsertError || !job) {
    console.error("[GaslessRelay] Job prepare failed:", upsertError);
    return NextResponse.json({ error: "Could not prepare the payment" }, { status: 500 });
  }
  return NextResponse.json(responseForJob(job));
}
