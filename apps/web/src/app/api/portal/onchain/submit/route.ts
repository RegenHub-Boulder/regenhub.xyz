import { NextResponse } from "next/server";
import { isHash } from "viem";
import { createServiceClient } from "@/lib/supabase/admin";
import { isOnchainBillingConfigured } from "@/lib/onchain/config";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { processOnchainInvoice } from "@/lib/onchain/verifyPayment";
import { AuditAction, logAction } from "@/lib/auditLog";

export async function POST(request: Request) {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOnchainBillingConfigured()) {
    return NextResponse.json({ error: "On-chain verification is not configured" }, { status: 503 });
  }
  const body = await request.json().catch(() => null) as {
    invoice_id?: number;
    tx_hash?: string;
  } | null;
  if (!body?.invoice_id || !body.tx_hash || !isHash(body.tx_hash)) {
    return NextResponse.json({ error: "Valid invoice and transaction hash required" }, { status: 400 });
  }
  const txHash = body.tx_hash.toLowerCase();

  const admin = createServiceClient();
  const { data: invoice } = await admin
    .from("onchain_invoices")
    .select("id, status, submitted_tx_hash")
    .eq("id", body.invoice_id)
    .eq("member_id", session.member.id)
    .maybeSingle();
  if (invoice?.status === "void") return reportPaymentAfterVoid(admin, session.member.id, invoice.id, txHash);
  if (!invoice || !["open", "submitted", "detected", "exception"].includes(invoice.status)) {
    return NextResponse.json({ error: "Open invoice not found" }, { status: 404 });
  }
  if (invoice.status !== "exception" && invoice.submitted_tx_hash && invoice.submitted_tx_hash !== txHash) {
    return NextResponse.json({ error: "Invoice already has a different transaction" }, { status: 409 });
  }

  const { data: submitted, error: updateError } = await admin
    .from("onchain_invoices")
    .update({
      status: "submitted",
      submitted_tx_hash: txHash,
      submitted_at: new Date().toISOString(),
      exception_reason: null,
    })
    .eq("id", invoice.id)
    // Only while still payable: it may have been paid or voided since it was read.
    .in("status", ["open", "submitted", "detected", "exception"])
    .select("id")
    .maybeSingle();
  if (updateError) {
    console.error("[OnchainSubmit] could not record transaction:", updateError);
    return NextResponse.json({ error: "Could not record the transaction; try again" }, { status: 500 });
  }
  if (!submitted) {
    // Paid or voided since it was read.
    const { data: current } = await admin.from("onchain_invoices").select("status").eq("id", invoice.id).single();
    if (current?.status === "void") return reportPaymentAfterVoid(admin, session.member.id, invoice.id, txHash);
    return NextResponse.json({
      error: "This invoice can no longer be paid. If you already sent the payment, contact the hub.",
    }, { status: 409 });
  }

  try {
    return NextResponse.json(await processOnchainInvoice(admin, invoice.id));
  } catch (error) {
    console.error("[OnchainSubmit] verification failed:", error);
    return NextResponse.json({
      status: "submitted",
      txHash,
      warning: "Transaction saved; confirmation will retry automatically",
    }, { status: 202 });
  }
}

/**
 * The invoice was voided (e.g. the membership was canceled), but the member
 * may have sent the money already. Keep their claim, once per transaction,
 * for an admin to check on chain and refund. Unverified: it is only what the
 * member reported.
 */
async function reportPaymentAfterVoid(
  admin: ReturnType<typeof createServiceClient>,
  memberId: number,
  invoiceId: number,
  txHash: string,
) {
  const { data: earlier, error } = await admin
    .from("admin_actions")
    .select("payload")
    .eq("action", AuditAction.ONCHAIN_PAYMENT_AFTER_VOID)
    .eq("target_table", "members")
    .eq("target_id", String(memberId));
  const failed = NextResponse.json({ error: "Could not record the transaction; try again" }, { status: 500 });
  if (error) return failed;
  const known = (earlier ?? []).some((row) => {
    const payload = row.payload as { invoice_id?: number; tx_hash?: string } | null;
    return payload?.invoice_id === invoiceId && payload.tx_hash === txHash;
  });
  if (!known) {
    const logged = await logAction({
      action: AuditAction.ONCHAIN_PAYMENT_AFTER_VOID,
      actorMemberId: memberId,
      target: { table: "members", id: memberId },
      payload: { invoice_id: invoiceId, tx_hash: txHash, verified: false },
    }, admin);
    if (!logged.ok) return failed;
  }
  return NextResponse.json({
    error: "This invoice was canceled, so it can no longer be paid. If you already sent the payment, the hub has your transaction and will sort it out.",
  }, { status: 409 });
}
