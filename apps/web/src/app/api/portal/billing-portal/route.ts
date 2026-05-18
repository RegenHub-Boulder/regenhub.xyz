import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createCustomerPortalSession, isStripeConfigured } from "@/lib/stripe";

export async function POST() {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: member } = await supabase
    .from("members")
    .select("id, name, email, stripe_customer_id")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) {
    return NextResponse.json({ error: "Member profile not found" }, { status: 404 });
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";
  const returnUrl = process.env.STRIPE_CUSTOMER_PORTAL_RETURN_URL ?? `${baseUrl}/portal`;

  try {
    const session = await createCustomerPortalSession(member, returnUrl);
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[BillingPortal] Stripe error:", err);
    const msg = err instanceof Error ? err.message : "Stripe request failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
