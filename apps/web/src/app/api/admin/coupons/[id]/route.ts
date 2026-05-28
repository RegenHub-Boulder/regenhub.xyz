import type Stripe from "stripe";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" as const, status: 401 };
  const { data: adminMember } = await supabase
    .from("members")
    .select("is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!adminMember?.is_admin) return { error: "Forbidden" as const, status: 403 };
  return { ok: true as const };
}

type PromoNewShape = Stripe.PromotionCode & {
  promotion?: { type: "coupon"; coupon?: string | Stripe.Coupon };
};

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
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

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

/**
 * DELETE /api/admin/coupons/[id]
 *
 * id = promotion code id ("promo_…"). Stripe doesn't actually let you
 * delete promotion codes, only coupons. So this:
 *   1. Resolves the underlying coupon id from the promotion code
 *   2. Deletes the coupon (irreversible — anyone with the code can no longer redeem)
 *   3. Deactivates the promotion code as a belt-and-suspenders measure
 *
 * After this, the orphaned promotion code stays in Stripe history but our
 * list endpoint filters it out (no coupon → toView returns null), so it
 * disappears from the admin UI.
 *
 * If the coupon is already gone (orphan), we just deactivate the promo code
 * and return success — the row vanishes from the list either way.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const stripe = getStripe();

  // Retrieve the promo code (with expanded coupon) to find the underlying coupon id.
  let promo: PromoNewShape;
  try {
    promo = (await stripe.promotionCodes.retrieve(id, {
      expand: ["promotion.coupon"],
    })) as PromoNewShape;
  } catch (err) {
    console.error("[Promo retrieve] error:", err);
    const msg = err instanceof Error ? err.message : "Promo code not found";
    return NextResponse.json({ error: msg }, { status: 404 });
  }

  const couponRef = promo.promotion?.coupon;
  const couponId =
    typeof couponRef === "string"
      ? couponRef
      : couponRef && typeof couponRef === "object"
        ? couponRef.id
        : null;

  // Delete the coupon (if it still exists) — this is what actually invalidates
  // the discount. Swallow not-found errors so a re-delete of an orphan is idempotent.
  if (couponId) {
    try {
      await stripe.coupons.del(couponId);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "resource_missing") {
        console.error("[Coupon delete] error:", err);
        const msg = err instanceof Error ? err.message : "Coupon delete failed";
        return NextResponse.json({ error: msg }, { status: 502 });
      }
    }
  }

  // Belt-and-suspenders: also deactivate the promo code so the UI's orphan
  // filter isn't the only thing keeping it out of view.
  try {
    if (promo.active) {
      await stripe.promotionCodes.update(id, { active: false });
    }
  } catch (err) {
    console.error("[Promo deactivate during delete] error:", err);
    // Non-fatal — the coupon is already gone, so the code is effectively dead.
  }

  return NextResponse.json({ ok: true, deleted_coupon_id: couponId });
}
