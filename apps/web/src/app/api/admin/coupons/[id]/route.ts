import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

/**
 * PATCH /api/admin/coupons/[id]
 *
 * id = promotion code id (e.g. "promo_…"). Stripe doesn't allow deleting
 * promotion codes; they can only be deactivated. Reactivation is allowed.
 *
 * Body: { active: boolean }
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: adminMember } = await supabase
    .from("members")
    .select("is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!adminMember?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { active?: boolean } | null;
  if (typeof body?.active !== "boolean") {
    return NextResponse.json({ error: "active (boolean) required" }, { status: 400 });
  }

  const stripe = getStripe();
  try {
    await stripe.promotionCodes.update(id, { active: body.active });
  } catch (err) {
    console.error("[Promo update] error:", err);
    const msg = err instanceof Error ? err.message : "Update failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  return NextResponse.json({ ok: true, active: body.active });
}
