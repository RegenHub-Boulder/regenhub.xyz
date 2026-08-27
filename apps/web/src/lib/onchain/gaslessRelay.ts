import { randomUUID } from "node:crypto";
import {
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { optimism } from "viem/chains";
import { createServiceClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import {
  assertOpPublicClient,
  getOpPublicClient,
  getOpRelayerPrivateKey,
  NATIVE_USDC_ADDRESS,
  ONCHAIN_CHAIN_ID,
  TREASURY_ADDRESS,
} from "./config";

type ServiceClient = ReturnType<typeof createServiceClient>;
export type RelayJob = Database["public"]["Tables"]["onchain_relay_jobs"]["Row"];

const WORKER_LEASE_MS = 5 * 60 * 1000;

class InvalidRelayJobError extends Error {}

export const USDC_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function assertRelayJobMatchesConfig(job: Pick<RelayJob, "token_contract" | "treasury_address">) {
  if (getAddress(job.token_contract) !== getAddress(NATIVE_USDC_ADDRESS)) {
    throw new InvalidRelayJobError("relay job token does not match native OP USDC");
  }
  if (getAddress(job.treasury_address) !== getAddress(TREASURY_ADDRESS)) {
    throw new InvalidRelayJobError("relay job treasury does not match configured treasury");
  }
}

const USDC_AUTHORIZATION_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);

const AUTHORIZATION_USED_EVENT = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);
const AUTHORIZATION_CANCELED_EVENT = parseAbiItem(
  "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
);
const MAX_LOG_BLOCKS_PER_REQUEST = BigInt(10);

export function authorizationTypedData(job: Pick<RelayJob,
  "from_address" | "token_contract" | "treasury_address" | "amount_usdc_micros" | "valid_after" | "valid_before" | "authorization_nonce"
>) {
  assertRelayJobMatchesConfig(job);
  return {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: ONCHAIN_CHAIN_ID,
      verifyingContract: NATIVE_USDC_ADDRESS,
    },
    types: USDC_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: getAddress(job.from_address),
      to: getAddress(job.treasury_address),
      value: BigInt(job.amount_usdc_micros),
      validAfter: BigInt(job.valid_after),
      validBefore: BigInt(job.valid_before),
      nonce: job.authorization_nonce as Hex,
    },
  };
}

export function publicAuthorization(job: RelayJob) {
  const typed = authorizationTypedData(job);
  return {
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: {
      ...typed.message,
      value: typed.message.value.toString(),
      validAfter: typed.message.validAfter.toString(),
      validBefore: typed.message.validBefore.toString(),
    },
  };
}

async function claimWorker(admin: ServiceClient) {
  const token = randomUUID();
  const claimedAt = new Date().toISOString();
  const staleAt = new Date(Date.now() - WORKER_LEASE_MS).toISOString();
  const tryClaim = async (availability: "unclaimed" | "stale") => {
    let query = admin
      .from("onchain_relay_worker")
      .update({ lease_token: token, lease_claimed_at: claimedAt })
      .eq("singleton", true);
    query = availability === "unclaimed"
      ? query.is("lease_claimed_at", null)
      : query.lte("lease_claimed_at", staleAt);
    const { data, error } = await query.select("lease_token").maybeSingle();
    if (error) throw error;
    return data?.lease_token === token;
  };

  // PostgREST 12.2.12 miscompiles an OR filter on this PATCH into a qualified
  // column reference that PostgreSQL rejects, even though the column exists.
  // Two individually atomic conditional updates preserve the same lease
  // semantics: claim an empty lease first, then recover a stale one.
  if (await tryClaim("unclaimed")) return token;
  return await tryClaim("stale") ? token : null;
}

async function releaseWorker(admin: ServiceClient, token: string) {
  const { error } = await admin
    .from("onchain_relay_worker")
    .update({ lease_token: null, lease_claimed_at: null })
    .eq("singleton", true)
    .eq("lease_token", token);
  if (error) console.error("[GaslessRelay] Could not release worker lease:", error);
}

async function recordSubmittedTransaction(
  admin: ServiceClient,
  job: RelayJob,
  txHash: Hash,
) {
  const normalized = txHash.toLowerCase();
  const submittedAt = new Date().toISOString();
  const { error: jobError } = await admin
    .from("onchain_relay_jobs")
    .update({
      status: "submitted",
      submitted_tx_hash: normalized,
      submitted_at: submittedAt,
      last_error: null,
    })
    .eq("invoice_id", job.invoice_id);
  if (jobError) throw jobError;

  const { data: invoice, error: invoiceError } = await admin
    .from("onchain_invoices")
    .select("status, submitted_tx_hash")
    .eq("id", job.invoice_id)
    .single();
  if (invoiceError) throw invoiceError;
  if (invoice.submitted_tx_hash && invoice.submitted_tx_hash !== normalized) {
    throw new Error("invoice already has a different transaction");
  }
  if (invoice.status === "paid") return;
  if (!["open", "exception", "submitted", "detected"].includes(invoice.status)) {
    throw new Error(`invoice is not relayable (status=${invoice.status})`);
  }
  const { error: updateError } = await admin
    .from("onchain_invoices")
    .update({
      status: "submitted",
      submitted_tx_hash: normalized,
      submitted_at: submittedAt,
      exception_reason: null,
    })
    .eq("id", job.invoice_id);
  if (updateError) throw updateError;
}

async function recoverUsedAuthorization(
  admin: ServiceClient,
  job: RelayJob,
): Promise<Hash | null> {
  const client = getOpPublicClient();
  await assertOpPublicClient(client);
  const observedBlock = await client.getBlockNumber();
  const used = await client.readContract({
    address: getAddress(job.token_contract),
    abi: USDC_AUTHORIZATION_ABI,
    functionName: "authorizationState",
    args: [getAddress(job.from_address), job.authorization_nonce as Hex],
    blockNumber: observedBlock,
  });
  if (!used) return null;

  const fromBlock = BigInt(job.authorization_from_block);
  let throughBlock = observedBlock;
  const latest = await client.getBlock({ blockNumber: observedBlock });
  if (latest.timestamp > BigInt(job.valid_before)) {
    const anchor = await client.getBlock({ blockNumber: fromBlock });
    if (anchor.timestamp >= BigInt(job.valid_before)) {
      throughBlock = fromBlock;
    } else {
      let low = fromBlock;
      let high = observedBlock;
      while (low < high) {
        const middle = (low + high + BigInt(1)) / BigInt(2);
        const block = await client.getBlock({ blockNumber: middle });
        if (block.timestamp < BigInt(job.valid_before)) low = middle;
        else high = middle - BigInt(1);
      }
      throughBlock = low;
    }
  }

  let authorizationLogs: Awaited<ReturnType<typeof client.getLogs>> = [];
  for (let chunkStart = fromBlock; chunkStart <= throughBlock; chunkStart += MAX_LOG_BLOCKS_PER_REQUEST) {
    const chunkEnd = chunkStart + MAX_LOG_BLOCKS_PER_REQUEST - BigInt(1) < throughBlock
      ? chunkStart + MAX_LOG_BLOCKS_PER_REQUEST - BigInt(1)
      : throughBlock;
    authorizationLogs = await client.getLogs({
      address: getAddress(job.token_contract),
      events: [AUTHORIZATION_USED_EVENT, AUTHORIZATION_CANCELED_EVENT],
      fromBlock: chunkStart,
      toBlock: chunkEnd,
    });
    authorizationLogs = authorizationLogs.filter((log) => {
      const args = (log as { args?: { authorizer?: string; nonce?: Hex } }).args;
      return args?.authorizer
        && getAddress(args.authorizer) === getAddress(job.from_address)
        && args.nonce?.toLowerCase() === job.authorization_nonce.toLowerCase();
    });
    if (authorizationLogs.length > 0) break;
  }

  const usedLogs = authorizationLogs.filter(
    (log) => (log as { eventName?: string }).eventName === "AuthorizationUsed",
  );
  const canceledLogs = authorizationLogs.filter(
    (log) => (log as { eventName?: string }).eventName === "AuthorizationCanceled",
  );
  const hashes = [...new Set(usedLogs
    .map((log) => log.transactionHash)
    .filter(Boolean))] as Hash[];
  if (hashes.length === 0) {
    if (canceledLogs.length > 0) {
      throw new InvalidRelayJobError("payment authorization was canceled in the wallet");
    }
    // Circle reports both used and canceled authorizations as consumed. Do
    // not infer a terminal cancellation from missing logs: a transient RPC
    // inconsistency must remain retryable so a real transfer is not orphaned.
    throw new Error("payment authorization is consumed but its event is not available yet");
  }
  if (hashes.length > 1) {
    throw new Error(`used authorization has ${hashes.length} matching transfer transactions`);
  }
  await recordSubmittedTransaction(admin, job, hashes[0]);
  return hashes[0];
}

async function assertRelayJobStillPayable(admin: ServiceClient, job: RelayJob) {
  assertRelayJobMatchesConfig(job);
  const { data: invoice, error: invoiceError } = await admin
    .from("onchain_invoices")
    .select("member_id, subscription_id, status, submitted_tx_hash, amount_usdc_micros, token_contract, treasury_address")
    .eq("id", job.invoice_id)
    .single();
  if (invoiceError || !invoice) throw new InvalidRelayJobError("relay invoice not found");
  if (invoice.member_id !== job.member_id) throw new InvalidRelayJobError("relay invoice member changed");
  if (!["open", "exception", "submitted", "detected"].includes(invoice.status)) {
    throw new InvalidRelayJobError(`invoice is not relayable (status=${invoice.status})`);
  }
  if (invoice.submitted_tx_hash && invoice.submitted_tx_hash !== job.submitted_tx_hash) {
    throw new InvalidRelayJobError("invoice already has a different transaction");
  }
  if (
    invoice.amount_usdc_micros !== job.amount_usdc_micros
    || getAddress(invoice.token_contract) !== getAddress(job.token_contract)
    || getAddress(invoice.treasury_address) !== getAddress(job.treasury_address)
  ) {
    throw new InvalidRelayJobError("relay job no longer matches its frozen invoice");
  }

  const { data: subscription } = await admin
    .from("subscriptions")
    .select("wallet_id")
    .eq("id", invoice.subscription_id)
    .eq("member_id", job.member_id)
    .eq("payment_rail", "onchain")
    .single();
  if (!subscription?.wallet_id) throw new InvalidRelayJobError("relay subscription has no verified wallet");
  if (subscription.wallet_id !== job.wallet_id) {
    throw new InvalidRelayJobError("relay authorization is not for the current verified wallet");
  }
  const { data: wallet } = await admin
    .from("member_wallets")
    .select("address")
    .eq("id", job.wallet_id)
    .eq("member_id", job.member_id)
    .eq("verification_method", "signature")
    .is("revoked_at", null)
    .single();
  if (!wallet || getAddress(wallet.address) !== getAddress(job.from_address)) {
    throw new InvalidRelayJobError("relay authorization is not from the current verified wallet");
  }
}

async function processRelayJob(admin: ServiceClient, job: RelayJob): Promise<Hash> {
  if (!job.signature) throw new Error("relay job has no authorization signature");
  if (job.status === "submitted" && job.submitted_tx_hash) {
    await recordSubmittedTransaction(admin, job, job.submitted_tx_hash as Hash);
    return job.submitted_tx_hash as Hash;
  }

  // An authorization may have reached OP immediately before this process lost
  // its database write. Recover the consumed nonce even after its signing
  // window has elapsed; expiring first could erase the only link to a transfer
  // that already moved the member's USDC.
  const recovered = await recoverUsedAuthorization(admin, job);
  if (recovered) return recovered;

  if (job.valid_before <= Math.floor(Date.now() / 1000)) {
    await admin
      .from("onchain_relay_jobs")
      .update({ status: "expired", last_error: "authorization expired before submission" })
      .eq("invoice_id", job.invoice_id);
    throw new Error("payment authorization expired; sign a new one");
  }

  await assertRelayJobStillPayable(admin, job);

  const client = getOpPublicClient();
  await assertOpPublicClient(client);
  const { error: submittingError } = await admin
    .from("onchain_relay_jobs")
    .update({
      status: "submitting",
      attempts: job.attempts + 1,
      last_error: null,
    })
    .eq("invoice_id", job.invoice_id);
  if (submittingError) throw submittingError;

  const account = privateKeyToAccount(getOpRelayerPrivateKey());
  const walletClient = createWalletClient({
    account,
    chain: optimism,
    transport: http(process.env.OP_RPC_URL),
  });
  const txHash = await walletClient.writeContract({
    address: getAddress(job.token_contract),
    abi: USDC_AUTHORIZATION_ABI,
    functionName: "transferWithAuthorization",
    args: [
      getAddress(job.from_address),
      getAddress(job.treasury_address),
      BigInt(job.amount_usdc_micros),
      BigInt(job.valid_after),
      BigInt(job.valid_before),
      job.authorization_nonce as Hex,
      job.signature as Hex,
    ],
  });
  await recordSubmittedTransaction(admin, job, txHash);
  return txHash;
}

/**
 * Process one signed authorization while holding the global relayer lease.
 * The lease serializes transaction nonces across overlapping web/cron workers.
 */
export async function processGaslessRelayQueue(
  admin: ServiceClient,
  preferredInvoiceId?: number,
) {
  const leaseToken = await claimWorker(admin);
  if (!leaseToken) return { status: "busy" as const };
  try {
    let query = admin
      .from("onchain_relay_jobs")
      .select("*")
      .in("status", ["signed", "submitting"]);
    if (preferredInvoiceId) query = query.eq("invoice_id", preferredInvoiceId);
    const { data: job, error } = await query
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!job) return { status: "empty" as const };
    try {
      const txHash = await processRelayJob(admin, job);
      return { status: "submitted" as const, invoiceId: job.invoice_id, txHash };
    } catch (error) {
      const message = error instanceof Error ? error.message : "relay submission failed";
      const retryUpdate = error instanceof InvalidRelayJobError
        ? { status: "expired" as const, last_error: message.slice(0, 500) }
        : { last_error: message.slice(0, 500) };
      await admin
        .from("onchain_relay_jobs")
        .update(retryUpdate)
        .eq("invoice_id", job.invoice_id)
        .neq("status", "submitted");
      throw error;
    }
  } finally {
    await releaseWorker(admin, leaseToken);
  }
}
