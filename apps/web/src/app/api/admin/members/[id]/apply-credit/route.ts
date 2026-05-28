import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe, getOrCreateCustomer, isStripeConfigured } from "@/lib/stripe";

/**
 * POST /api/admin/members/[id]/apply-credit
 *
 * Apply a customer-balance credit on the member's Stripe customer. Negative
 * balance = customer credit, which Stripe applies automatically to the next
 * invoice. Used to compensate for migration overlap (paid via Xero AND
 * Stripe for the same period), as a "X days free" goodwill gesture, etc.
 *
 * Body: { dollars: number, note: string }
 *
 * Returns: { ok: true, balance_cents: number, ending_balance_cents: number }
 *
 * Note: applies to the Stripe customer, not a specific subscription, so the
 * credit will also reduce one-off invoices (e.g. if you ever invoice them
 * separately for a workshop). If they have no future invoices, the credit
 * sits idle on their balance forever — Stripe doesn't expire it.
 */
export async function POST(
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
    .select("id, is_admin, name")
    .eq("supabase_user_id", user.id)
    .single();
  if (!adminMember?.is_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: idParam } = await ctx.params;
  const memberId = parseInt(idParam, 10);
  if (!memberId) return NextResponse.json({ error: "Invalid member id" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { dollars?: number; note?: string } | null;
  const dollars = Number(body?.dollars);
  const note = (body?.note ?? "").trim();
  if (!Number.isFinite(dollars) || dollars <= 0) {
    return NextResponse.json({ error: "dollars must be a positive number" }, { status: 400 });
  }
  if (dollars > 500) {
    return NextResponse.json(
      { error: "Credits over $500 need to go through Stripe Dashboard (sanity guard)." },
      { status: 400 },
    );
  }
  if (!note) {
    return NextResponse.json({ error: "Note required (admin audit trail)" }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: member } = await admin
    .from("members")
    .select("id, name, email, stripe_customer_id")
    .eq("id", memberId)
    .maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const stripe = getStripe();
  const customer = await getOrCreateCustomer(member);

  // Negative amount = customer credit. Cents.
  const amountCents = -Math.round(dollars * 100);

  try {
    const txn = await stripe.customers.createBalanceTransaction(customer.id, {
      amount: amountCents,
      currency: "usd",
      description: `[Admin credit by ${adminMember.name}] ${note}`,
      metadata: {
        applied_by_member_id: String(adminMember.id),
        target_member_id: String(member.id),
        note,
      },
    });

    // Backfill the customer ID on the member if we just created the customer.
    if (!member.stripe_customer_id) {
      await admin
        .from("members")
        .update({ stripe_customer_id: customer.id })
        .eq("id", member.id);
    }

    return NextResponse.json({
      ok: true,
      balance_cents: txn.amount,
      ending_balance_cents: txn.ending_balance,
    });
  } catch (err) {
    console.error("[ApplyCredit] Stripe error:", err);
    const msg = err instanceof Error ? err.message : "Credit failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
