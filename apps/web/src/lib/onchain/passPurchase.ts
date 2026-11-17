import { createServiceClient } from "@/lib/supabase/admin";
import { dayPassCentsForMember } from "@/lib/dayPassPrice";
import { NATIVE_USDC_ADDRESS, ONCHAIN_CHAIN_ID, TREASURY_ADDRESS } from "./config";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** How long an unpaid USDC day pass purchase holds its price before it expires. */
export const ONCHAIN_PASS_INVOICE_MINUTES = 60;
/** Hold left below which a new payment authorization isn't issued (relay prepare): enough to switch network and sign. */
export const PASS_SIGNING_WINDOW_SECONDS = 5 * 60;

// Still payable: an exception (wrong amount, or a reverted relay that is retried) too, until it expires.
const UNPAID = ["open", "submitted", "detected", "exception"] as const;
const SETUP_COLUMNS = "id, amount_cents, amount_usdc_micros, due_at, status, submitted_tx_hash";

export type PassInvoiceSetup = {
  invoice: {
    id: number;
    amount_cents: number;
    amount_usdc_micros: number;
    due_at: string;
    status: string;
    submitted_tx_hash: string | null;
  };
  payment: { chain_id: number; token_address: string; treasury_address: string };
};

export class PassPurchaseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The frozen invoice row for one day pass: price, payer wallet and expiry fixed now. */
export function passInvoiceValues(args: { memberId: number; walletId: number; amountCents: number; now?: Date }) {
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) throw new Error("pass price must be positive cents");
  const now = args.now ?? new Date();
  const expires = new Date(now.getTime() + ONCHAIN_PASS_INVOICE_MINUTES * 60 * 1000).toISOString();
  return {
    kind: "day_pass" as const,
    subscription_id: null,
    wallet_id: args.walletId,
    member_id: args.memberId,
    period_start: now.toISOString(),
    period_end: expires,
    due_at: expires,
    base_amount_cents: args.amountCents,
    discount_bps: 0,
    amount_cents: args.amountCents,
    amount_usdc_micros: args.amountCents * 10_000,
    chain_id: ONCHAIN_CHAIN_ID,
    token_contract: NATIVE_USDC_ADDRESS,
    treasury_address: TREASURY_ADDRESS,
    status: "open" as const,
  };
}

function setup(invoice: PassInvoiceSetup["invoice"]): PassInvoiceSetup {
  return {
    invoice,
    payment: { chain_id: ONCHAIN_CHAIN_ID, token_address: NATIVE_USDC_ADDRESS, treasury_address: TREASURY_ADDRESS },
  };
}

/**
 * Start (or resume) buying one day pass with USDC. Needs a signature-verified
 * wallet. A member has at most one unpaid pass purchase (unique index, 063):
 * an unexpired one is resumed at its frozen price; a stale one is expired
 * first so a fresh price can be issued.
 */
export async function startOnchainPassPurchase(admin: ServiceClient, memberId: number, now = new Date()): Promise<PassInvoiceSetup> {
  const { data: wallet, error: walletError } = await admin
    .from("member_wallets")
    .select("id")
    .eq("member_id", memberId)
    .eq("verification_method", "signature")
    .is("revoked_at", null)
    .maybeSingle();
  if (walletError) throw walletError;
  if (!wallet) throw new PassPurchaseError("Connect and verify a wallet first.", 409);

  // Finish off this member's stale purchase before looking (the cron does
  // the same for everyone): one too close to its end to sign counts as stale.
  const staleBy = new Date(now.getTime() + PASS_SIGNING_WINDOW_SECONDS * 1000).toISOString();
  const { error: expireError } = await admin.rpc("expire_onchain_pass_invoices", { p_now: staleBy, p_member_id: memberId });
  if (expireError) throw expireError;

  const findOpen = async () => {
    const { data, error } = await admin.from("onchain_invoices").select(`${SETUP_COLUMNS}, wallet_id`)
      .eq("member_id", memberId).eq("kind", "day_pass").in("status", [...UNPAID]).maybeSingle();
    if (error) throw error;
    return data as (PassInvoiceSetup["invoice"] & { wallet_id: number }) | null;
  };
  let open = await findOpen();
  if (open && open.wallet_id !== wallet.id) {
    // Bought from a wallet that isn't the member's any more: the revoke
    // trigger drops these, but skips one that was locked at that moment
    // (063). It can't be paid from a revoked wallet; drop it unless a
    // payment is on its way.
    const { error } = await admin.rpc("expire_onchain_pass_invoices", { p_now: "infinity", p_member_id: memberId, p_wallet_id: open.wallet_id });
    if (error) throw error;
    open = await findOpen();
  }
  if (open) {
    const invoice: Partial<typeof open> = { ...open };
    delete invoice.wallet_id;
    return setup(invoice as PassInvoiceSetup["invoice"]);
  }

  const { cents } = await dayPassCentsForMember(admin, memberId);
  const { data: invoice, error: insertError } = await admin
    .from("onchain_invoices")
    .insert(passInvoiceValues({ memberId, walletId: wallet.id, amountCents: cents, now }))
    .select(SETUP_COLUMNS)
    .single();
  if (insertError?.code === "23505") {
    // A second tab made it first: resume that one.
    const { data: raced } = await admin.from("onchain_invoices").select(SETUP_COLUMNS)
      .eq("member_id", memberId).eq("kind", "day_pass").in("status", [...UNPAID]).maybeSingle();
    if (raced) return setup(raced as PassInvoiceSetup["invoice"]);
  }
  if (insertError || !invoice) throw insertError ?? new Error("pass invoice insert returned nothing");
  return setup(invoice as PassInvoiceSetup["invoice"]);
}
