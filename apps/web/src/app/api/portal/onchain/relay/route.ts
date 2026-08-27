import { NextResponse } from "next/server";
import { isHex, size, type Hex } from "viem";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  assertOpPublicClient,
  getOpPublicClient,
  isGaslessRelayConfigured,
} from "@/lib/onchain/config";
import {
  authorizationTypedData,
  processGaslessRelayQueue,
} from "@/lib/onchain/gaslessRelay";
import { requirePortalMember } from "@/lib/onchain/portalMember";

export async function POST(request: Request) {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isGaslessRelayConfigured()) {
    return NextResponse.json({ error: "Gasless USDC payments are not configured" }, { status: 503 });
  }
  const body = await request.json().catch(() => null) as {
    invoice_id?: number;
    signature?: string;
  } | null;
  if (!Number.isInteger(body?.invoice_id) || (body?.invoice_id ?? 0) <= 0) {
    return NextResponse.json({ error: "Valid invoice required" }, { status: 400 });
  }
  if (body?.signature && (!isHex(body.signature, { strict: true }) || size(body.signature) > 2048)) {
    return NextResponse.json({ error: "Valid authorization signature required" }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: job, error: jobError } = await admin
    .from("onchain_relay_jobs")
    .select("*")
    .eq("invoice_id", body!.invoice_id!)
    .eq("member_id", session.member.id)
    .maybeSingle();
  if (jobError) {
    console.error("[GaslessRelay] Job lookup failed:", jobError);
    return NextResponse.json({ error: "Could not queue the payment" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "Prepared payment not found" }, { status: 404 });
  if (job.status === "submitted" && job.submitted_tx_hash) {
    return NextResponse.json({ status: "submitted", txHash: job.submitted_tx_hash });
  }
  if (!job.signature && job.valid_before <= Math.floor(Date.now() / 1000)) {
    await admin.from("onchain_relay_jobs").update({ status: "expired" }).eq("invoice_id", job.invoice_id);
    return NextResponse.json({ error: "Payment authorization expired; try again" }, { status: 409 });
  }

  const normalizedSignature = body?.signature?.toLowerCase() as Hex | undefined;
  if (job.signature && normalizedSignature && job.signature !== normalizedSignature) {
    return NextResponse.json({ error: "A different payment authorization is already queued" }, { status: 409 });
  }
  if (!job.signature) {
    if (!normalizedSignature) {
      return NextResponse.json({ error: "Authorization signature required" }, { status: 400 });
    }
    const client = getOpPublicClient();
    await assertOpPublicClient(client);
    const valid = await client.verifyTypedData({
      address: job.from_address as `0x${string}`,
      ...authorizationTypedData(job),
      signature: normalizedSignature,
    });
    if (!valid) return NextResponse.json({ error: "Wallet authorization signature is invalid" }, { status: 401 });
    const { data: signed, error: signedError } = await admin
      .from("onchain_relay_jobs")
      .update({
        signature: normalizedSignature,
        status: "signed",
        signed_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("invoice_id", job.invoice_id)
      .eq("status", "prepared")
      .is("signature", null)
      .select("invoice_id")
      .maybeSingle();
    if (signedError) {
      console.error("[GaslessRelay] Could not store authorization:", signedError);
      return NextResponse.json({ error: "Could not queue the payment" }, { status: 500 });
    }
    if (!signed) {
      const { data: current } = await admin
        .from("onchain_relay_jobs")
        .select("signature")
        .eq("invoice_id", job.invoice_id)
        .single();
      if (current?.signature !== normalizedSignature) {
        return NextResponse.json({ error: "Payment authorization changed while submitting" }, { status: 409 });
      }
    }
  }

  try {
    const result = await processGaslessRelayQueue(admin, job.invoice_id);
    if (result.status === "submitted") {
      return NextResponse.json({ status: "submitted", txHash: result.txHash });
    }
    return NextResponse.json({ status: "queued" }, { status: 202 });
  } catch (error) {
    console.error("[GaslessRelay] Submission failed; queued for retry:", error);
    return NextResponse.json({
      status: "queued",
      warning: "Payment authorization saved; RegenHub will retry the gas-sponsored submission",
    }, { status: 202 });
  }
}
