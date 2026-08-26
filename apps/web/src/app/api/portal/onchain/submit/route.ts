import { NextResponse } from "next/server";
import { isHash } from "viem";
import { createServiceClient } from "@/lib/supabase/admin";
import { isOnchainBillingConfigured } from "@/lib/onchain/config";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { processOnchainInvoice } from "@/lib/onchain/verifyPayment";

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
  if (!invoice || !["open", "submitted", "detected", "exception"].includes(invoice.status)) {
    return NextResponse.json({ error: "Open invoice not found" }, { status: 404 });
  }
  if (invoice.status !== "exception" && invoice.submitted_tx_hash && invoice.submitted_tx_hash !== txHash) {
    return NextResponse.json({ error: "Invoice already has a different transaction" }, { status: 409 });
  }

  const { error: updateError } = await admin
    .from("onchain_invoices")
    .update({
      status: "submitted",
      submitted_tx_hash: txHash,
      submitted_at: new Date().toISOString(),
      exception_reason: null,
    })
    .eq("id", invoice.id);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 409 });

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
