import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createPassCheckoutSession, isStripeConfigured, PASS_KINDS } from "@/lib/stripe";
import type { PurchaseKind } from "@/lib/supabase/types";

export async function POST(req: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { kind?: PurchaseKind } | null;
  const kind = body?.kind;
  if (!kind || !(kind in PASS_KINDS)) {
    return NextResponse.json({ error: "Missing or unknown kind" }, { status: 400 });
  }

  const { data: member } = await supabase
    .from("members")
    .select("id, name, email, stripe_customer_id")
    .eq("supabase_user_id", user.id)
    .single();
  if (!member) {
    return NextResponse.json({ error: "Member profile not found" }, { status: 404 });
  }

  // Contributing-member rate ($25 vs $30 on single day passes) applies to anyone
  // with an active paid subscription — checks both billable subs and the legacy
  // member-type signal (hub_friend etc. read as members for pricing purposes).
  const { data: activeSub } = await supabase
    .from("subscriptions")
    .select("id")
    .eq("member_id", member.id)
    .in("status", ["active", "trialing"])
    .limit(1)
    .maybeSingle();
  const isMember = !!activeSub;

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";

  try {
    const session = await createPassCheckoutSession({
      member,
      kind,
      isMember,
      successUrl: `${baseUrl}/portal/passes?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/portal/passes?checkout=cancelled`,
    });
    if (!session.url) throw new Error("Stripe returned no checkout URL");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[BuyPasses] Stripe error:", err);
    const msg = err instanceof Error ? err.message : "Stripe request failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
