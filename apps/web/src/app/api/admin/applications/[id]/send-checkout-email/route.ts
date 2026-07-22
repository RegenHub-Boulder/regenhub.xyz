import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendApplicationCheckoutEmail } from "@/lib/applicationCheckout";

/**
 * POST /api/admin/applications/[id]/send-checkout-email
 *
 * (Re)sends the approval email carrying the Stripe Checkout link. The approve
 * route sends this automatically; this endpoint covers resends and the cases
 * where the auto-send failed or the approval predates auto-sending. Expired
 * Stripe sessions are regenerated before emailing (see lib/applicationCheckout).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  // Two auth paths: an admin browser session (the panel button), or the
  // CRON_SECRET bearer used by system/ops callers (same pattern as the cron
  // routes) so this can be triggered without a browser.
  const cronSecret = process.env.CRON_SECRET;
  const isSystemCaller =
    !!cronSecret && req.headers.get("authorization") === `Bearer ${cronSecret}`;

  if (!isSystemCaller) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: adminMember } = await supabase
      .from("members")
      .select("is_admin")
      .eq("supabase_user_id", user.id)
      .single();
    if (!adminMember?.is_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { id: idParam } = await ctx.params;
  const applicationId = parseInt(idParam, 10);
  if (!applicationId) {
    return NextResponse.json({ error: "Invalid application id" }, { status: 400 });
  }

  const result = await sendApplicationCheckoutEmail(applicationId, createServiceClient());
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, email_to: result.email_to, regenerated: result.regenerated ?? false });
}
