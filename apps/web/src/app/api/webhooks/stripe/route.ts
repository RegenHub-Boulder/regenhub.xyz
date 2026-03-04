import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createServiceClient } from "@/lib/supabase/admin";

// Map Stripe price IDs → number of day passes to grant
function passCountForPrice(priceId: string): number {
  if (priceId === process.env.STRIPE_PRICE_DAYPASS) return 1;
  if (priceId === process.env.STRIPE_PRICE_FIVEPACK) return 5;
  return 0;
}

// Must be raw body for Stripe signature verification
export async function POST(request: Request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Missing signature or webhook secret" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[Stripe] Webhook signature failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // client_reference_id = member ID, set via ?client_reference_id= on payment link URL
    const memberId = session.client_reference_id;
    if (!memberId) {
      console.warn("[Stripe] checkout.session.completed with no client_reference_id — skipping");
      return NextResponse.json({ received: true });
    }

    // Fetch line items to determine which product was purchased
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
    let passCount = 0;
    for (const item of lineItems.data) {
      if (item.price?.id) {
        passCount += passCountForPrice(item.price.id) * (item.quantity ?? 1);
      }
    }

    if (passCount === 0) {
      console.warn("[Stripe] No matching price IDs in session", session.id);
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();
    const { data: member } = await supabase
      .from("members")
      .select("id, name, day_passes_balance")
      .eq("id", parseInt(memberId))
      .single();

    if (!member) {
      console.error("[Stripe] Member not found for id:", memberId);
      return NextResponse.json({ received: true });
    }

    const newBalance = member.day_passes_balance + passCount;
    await supabase
      .from("members")
      .update({ day_passes_balance: newBalance })
      .eq("id", member.id);

    console.log(`[Stripe] +${passCount} passes for ${member.name} (id=${member.id}) → balance=${newBalance}`);
  }

  return NextResponse.json({ received: true });
}
