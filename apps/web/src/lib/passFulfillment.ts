import type Stripe from "stripe";
import { createServiceClient } from "@/lib/supabase/admin";
import { PASS_KINDS } from "@/lib/stripe";
import type { PurchaseKind } from "@/lib/supabase/types";

type ServiceClient = ReturnType<typeof createServiceClient>;

async function notifyTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("[PassFulfillment] Telegram notify error:", err);
  }
}

export interface FulfillmentResult {
  status: "granted" | "already_processed" | "skipped";
  member_id?: number;
  passes_granted?: number;
  new_balance?: number;
  reason?: string;
}

/**
 * Idempotently grant day passes for a completed Stripe Checkout Session.
 *
 * Called by both the Stripe webhook (`checkout.session.completed`) AND the
 * `/portal/passes?session_id=…` success page — whichever lands first wins.
 * The other is a no-op (UNIQUE on purchases.stripe_checkout_session).
 *
 * Reads kind + passes_granted from session.metadata (set when we create the
 * session in createPassCheckoutSession). Resolves member by client_reference_id
 * → email → auto-create.
 */
export async function fulfillPassPurchase(
  session: Stripe.Checkout.Session,
  admin: ServiceClient = createServiceClient(),
): Promise<FulfillmentResult> {
  if (session.mode !== "payment") {
    return { status: "skipped", reason: "not a payment-mode session" };
  }
  if (session.payment_status !== "paid") {
    return { status: "skipped", reason: `payment_status=${session.payment_status}` };
  }

  const kind = session.metadata?.kind as PurchaseKind | undefined;
  const def = kind ? PASS_KINDS[kind] : undefined;
  if (!kind || !def) {
    return { status: "skipped", reason: "no kind in session metadata" };
  }

  // Idempotency check: if we already recorded this session, no-op
  const { data: existing } = await admin
    .from("purchases")
    .select("id, member_id, passes_granted")
    .eq("stripe_checkout_session", session.id)
    .maybeSingle();
  if (existing) {
    return {
      status: "already_processed",
      member_id: existing.member_id ?? undefined,
      passes_granted: existing.passes_granted,
    };
  }

  // Resolve member: client_reference_id > email > auto-create
  const customerEmail =
    session.customer_details?.email ??
    session.customer_email ??
    null;

  let memberId: number | null = null;
  let memberName: string | null = null;
  let isFirstTime = false;

  if (session.client_reference_id) {
    const id = parseInt(session.client_reference_id, 10);
    if (Number.isFinite(id)) {
      const { data: m } = await admin
        .from("members")
        .select("id, name")
        .eq("id", id)
        .maybeSingle();
      if (m) {
        memberId = m.id;
        memberName = m.name;
      }
    }
  }

  if (!memberId && customerEmail) {
    const { data: m } = await admin
      .from("members")
      .select("id, name")
      .eq("email", customerEmail)
      .maybeSingle();
    if (m) {
      memberId = m.id;
      memberName = m.name;
    } else {
      // First-time buyer with no member record: auto-create as day_pass
      const name = session.customer_details?.name?.trim() || customerEmail.split("@")[0];
      const { data: created } = await admin
        .from("members")
        .insert({
          name,
          email: customerEmail,
          member_type: "day_pass",
        })
        .select("id, name")
        .single();
      if (created) {
        memberId = created.id;
        memberName = created.name;
        isFirstTime = true;
      }
    }
  }

  if (!memberId) {
    console.error("[PassFulfillment] Could not resolve member for session", session.id);
    return { status: "skipped", reason: "no member resolved" };
  }

  const passesToGrant = def.quantity;

  // Atomic increment
  const { data: newBalance, error: rpcError } = await admin.rpc(
    "increment_day_pass_balance",
    { p_member_id: memberId, p_amount: passesToGrant },
  );
  if (rpcError) {
    console.error("[PassFulfillment] balance increment failed:", rpcError);
    throw rpcError;
  }

  // Audit row — UNIQUE on stripe_checkout_session is our second-line idempotency guard
  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  await admin.from("purchases").upsert(
    {
      member_id: memberId,
      stripe_checkout_session: session.id,
      stripe_payment_intent: paymentIntent,
      kind,
      amount_cents: session.amount_total ?? def.cents,
      passes_granted: passesToGrant,
      email: customerEmail,
    },
    { onConflict: "stripe_checkout_session" },
  );

  console.log(
    `[PassFulfillment] +${passesToGrant} passes for ${memberName} (id=${memberId}) → balance=${newBalance}`,
  );

  if (isFirstTime) {
    // Send a magic-link so the brand-new member can claim their portal.
    // Without this, they paid + got a member record but have no auth
    // account, so they can't sign in to see their balance / get a code.
    if (customerEmail) {
      const baseUrl =
        process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";
      const { error: otpErr } = await admin.auth.signInWithOtp({
        email: customerEmail,
        options: {
          emailRedirectTo: `${baseUrl}/auth/callback?next=/portal/passes`,
          shouldCreateUser: true,
        },
      });
      if (otpErr) {
        console.error("[PassFulfillment] OTP send failed:", otpErr);
      }
    }

    const reviewUrl = `https://regenhub.xyz/admin/members/${memberId}`;
    await notifyTelegram(
      [
        `🆕 *First-time day-pass buyer*`,
        ``,
        `*${memberName}* · ${customerEmail}`,
        `Bought: ${def.label} ($${(session.amount_total ?? def.cents) / 100})`,
        `Sign-in email sent to claim their portal.`,
        ``,
        `[Review →](${reviewUrl})`,
      ].join("\n"),
    );
  }

  return {
    status: "granted",
    member_id: memberId,
    passes_granted: passesToGrant,
    new_balance: typeof newBalance === "number" ? newBalance : undefined,
  };
}
