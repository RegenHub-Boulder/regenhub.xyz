import { NextResponse } from "next/server";
import { requireApprovalsViewer } from "@/lib/admin";
import { COOP_APPROVES } from "@/lib/approval";
import { approveFreeDay } from "@regenhub/shared";
import { logAction, AuditAction } from "@/lib/auditLog";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, freeDayApprovedEmail, freeDayDeclinedEmail } from "@/lib/email";
import { usuallyHere } from "@/lib/firstVisit";

/**
 * People → Free days. Who (migration 074): a site admin or a co-op member sees them; approving or turning down a
 * waiting request is a co-op member's (lib/approval.ts canApproveOnSite), in the chat anyone in it.
 */
export async function GET() {
  if (!await requireApprovalsViewer()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createServiceClient();

  const { data: claims, error } = await admin
    .from("free_day_claims")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ claims: claims ?? [] });
}

export async function PATCH(request: Request) {
  const viewer = await requireApprovalsViewer();
  if (!viewer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { member } = viewer;

  const admin = createServiceClient();
  const body = await request.json();
  // A free day is only a free day: joining is an application (vouch, then one approval; T-482 round 5).
  const { id, status } = body as { id: number; status: string };

  if (!id || !status) {
    return NextResponse.json({ error: "id and status required" }, { status: 400 });
  }

  const validStatuses = ["pending", "reserved", "activated", "expired", "cancelled"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${validStatuses.join(", ")}` }, { status: 400 });
  }

  // Read pre-update so we can detect the pending → reserved transition
  const { data: prev } = await admin
    .from("free_day_claims")
    .select("status, name, email")
    .eq("id", id)
    .single();

  // A free day is approved only from waiting (the one approval below), never set straight to approved by hand.
  if (status === "reserved" && prev && prev.status !== "pending") {
    return NextResponse.json({ error: "Only a waiting request can be approved: move it back to waiting first." }, { status: 409 });
  }
  // Every decision on a free day (approve, turn down, cancel, move back) is a co-op member's (migration 074).
  if (!member.canApprove) {
    return NextResponse.json({ error: `${COOP_APPROVES} or turn down free days on the site.` }, { status: 403 });
  }

  // Approving: the one function the chat card's button calls too (@regenhub/shared approveFreeDay, migration 074):
  // pending → reserved, who approved, the audit row; only one approval sends the email.
  if (prev?.status === "pending" && status === "reserved") {
    const result = await approveFreeDay(admin, id, { site: { memberId: member.id, name: member.name } });
    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : result.reason === "not_allowed" ? 403 : 409;
      return NextResponse.json({ error: result.message, reason: result.reason }, { status: code });
    }
    if (!result.already && result.email) {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
      const tpl = freeDayApprovedEmail({ name: result.name, siteUrl, usuallyHere: await usuallyHere(admin) });
      sendEmail({ kind: "free_day_approved", to: result.email, subject: tpl.subject, html: tpl.html, text: tpl.text })
        .catch((err) => console.error("[AdminClaims] email send failed:", err));
    }
    return NextResponse.json({ success: true, already: result.already });
  }

  // Conditional on the status read above, so two clicks can't both send the decline email.
  let update = admin.from("free_day_claims").update({ status }).eq("id", id);
  if (prev) update = update.eq("status", prev.status);
  const { data: moved, error } = await update.select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const changed = (moved ?? []).length > 0;

  if (changed && prev?.status === "pending" && status === "cancelled") {
    await logAction({ action: AuditAction.FREE_DAY_REJECTED, actorMemberId: member.id, target: { table: "free_day_claims", id } }, admin);
  }
  // Turned down before it was approved: a kind note, so they aren't left waiting.
  if (changed && prev && prev.status === "pending" && status === "cancelled" && prev.email) {
    const tpl = freeDayDeclinedEmail({ name: prev.name, siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz" });
    await sendEmail({ kind: "free_day_declined", to: prev.email, ...tpl })
      .catch((err) => console.error("[AdminClaims] decline email failed:", err));
  }

  return NextResponse.json({ success: true });
}
