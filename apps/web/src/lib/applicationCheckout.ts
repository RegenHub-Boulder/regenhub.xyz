import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, approvalCheckoutEmail } from "@/lib/email";
import {
  createApprovalCheckoutSession,
  getPlan,
  getStripe,
  isStripeConfigured,
} from "@/lib/stripe";

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface CheckoutEmailResult {
  ok: boolean;
  /** HTTP-ish status for the route wrapper. */
  status: number;
  error?: string;
  email_to?: string;
  /** True when the stored Stripe session was dead and a fresh one was minted. */
  regenerated?: boolean;
}

/**
 * (Re)send the approval email carrying the Stripe Checkout link for an
 * approved application. If the stored session is no longer open (sessions
 * expire ~24h), a fresh one is created from the approval's stored plan/rate/
 * discount and persisted before emailing — so old approvals never get a dead
 * link. Shared by the admin route and the MCP `send_checkout_email` tool.
 */
export async function sendApplicationCheckoutEmail(
  applicationId: number,
  admin: ServiceClient = createServiceClient(),
): Promise<CheckoutEmailResult> {
  const { data: application } = await admin
    .from("applications")
    .select("*")
    .eq("id", applicationId)
    .single();
  if (!application) {
    return { ok: false, status: 404, error: "Application not found" };
  }
  if (application.status !== "approved" || !application.stripe_checkout_url) {
    return { ok: false, status: 400, error: "Application has no checkout link — approve it first." };
  }
  if (application.checkout_completed_at) {
    return { ok: false, status: 400, error: "Checkout already completed — nothing to send." };
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";
  const plan = application.approved_plan_key ? getPlan(application.approved_plan_key) : null;

  // Verify the stored session is still open; regenerate if not. Emailing a
  // dead link is worse than no email — the applicant clicks and hits a Stripe
  // error page with no path forward.
  let checkoutUrl: string = application.stripe_checkout_url;
  let regenerated = false;
  if (isStripeConfigured() && application.stripe_checkout_session_id) {
    let needsFresh = false;
    try {
      const existing = await getStripe().checkout.sessions.retrieve(
        application.stripe_checkout_session_id,
      );
      needsFresh = existing.status !== "open" || !existing.url;
    } catch {
      needsFresh = true; // unretrievable → treat as dead
    }
    if (needsFresh) {
      if (!application.approved_plan_key || !application.approved_monthly_cents) {
        return {
          ok: false,
          status: 409,
          error: "Stored checkout session expired and the approval has no plan/rate to regenerate from — re-approve instead.",
        };
      }
      const { data: member } = await admin
        .from("members")
        .select("id, name, email, stripe_customer_id, member_type")
        .eq("email", application.email)
        .maybeSingle();
      if (!member) {
        return {
          ok: false,
          status: 409,
          error: "No member row for this applicant — re-approve instead (it recreates one).",
        };
      }
      try {
        const result = await createApprovalCheckoutSession({
          application_id: application.id,
          member,
          planKey: application.approved_plan_key,
          monthlyCents: application.approved_monthly_cents,
          discountCents: application.discount_cents ?? null,
          discountDuration: application.discount_duration ?? null,
          discountMonths: application.discount_months ?? null,
          discountNote: application.discount_note ?? null,
          successUrl: `${baseUrl}/portal?welcome=1`,
          cancelUrl: `${baseUrl}/portal?checkout=cancelled`,
        });
        if (!result.session.url) throw new Error("Stripe returned no checkout URL");
        checkoutUrl = result.session.url;
        regenerated = true;
        await admin
          .from("applications")
          .update({
            stripe_checkout_session_id: result.session.id,
            stripe_checkout_url: checkoutUrl,
            checkout_sent_at: new Date().toISOString(),
          })
          .eq("id", application.id);
      } catch (err) {
        console.error("[SendCheckoutEmail] Session regeneration failed:", err);
        const msg = err instanceof Error ? err.message : "Stripe request failed";
        return { ok: false, status: 502, error: `Session expired and regeneration failed: ${msg}` };
      }
    }
  }

  const tpl = approvalCheckoutEmail({
    name: application.name,
    planLabel: plan?.label ?? application.approved_plan_key ?? "Membership",
    monthlyCents: application.approved_monthly_cents ?? 0,
    discountCents: application.discount_cents,
    discountDuration: application.discount_duration,
    discountMonths: application.discount_months,
    checkoutUrl,
    siteUrl: baseUrl,
  });
  const sent = await sendEmail({
    to: application.email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });

  if (!sent) {
    return { ok: false, status: 502, error: "Email send failed — check server logs" };
  }
  return { ok: true, status: 200, email_to: application.email, regenerated };
}
