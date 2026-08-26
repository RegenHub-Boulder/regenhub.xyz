import { monthlyPassesCreditedEmail, sendEmail } from "@/lib/email";
import { getPlan, planLabel } from "@/lib/plans";
import { createServiceClient } from "@/lib/supabase/admin";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Grant a subscription period's passes exactly once across every payment rail. */
export async function grantSubscriptionPasses(
  admin: ServiceClient,
  args: {
    memberId: number;
    subscriptionId: number | null;
    planKey: string;
    billingEventKey: string;
    stripeInvoiceId?: string | null;
    notifyMember: boolean;
  },
) {
  const plan = getPlan(args.planKey);
  if (!plan?.monthlyDayPasses || plan.monthlyDayPasses <= 0) {
    return { granted: false, newBalance: null };
  }

  const { data: inserted, error: insertError } = await admin
    .from("pass_grants")
    .insert({
      member_id: args.memberId,
      subscription_id: args.subscriptionId,
      stripe_invoice_id: args.stripeInvoiceId ?? null,
      billing_event_key: args.billingEventKey,
      plan_key: args.planKey,
      passes_granted: plan.monthlyDayPasses,
    })
    .select("id")
    .maybeSingle();

  if (insertError) {
    if (insertError.code === "23505") return { granted: false, newBalance: null };
    console.error("[SubscriptionPasses] pass_grants insert failed:", insertError);
    return { granted: false, newBalance: null };
  }
  if (!inserted) return { granted: false, newBalance: null };

  const { data: newBalance, error: incrementError } = await admin.rpc(
    "increment_day_pass_balance",
    { p_member_id: args.memberId, p_amount: plan.monthlyDayPasses },
  );
  if (incrementError) {
    console.error("[SubscriptionPasses] balance increment failed:", incrementError);
    await admin.from("pass_grants").delete().eq("id", inserted.id);
    return { granted: false, newBalance: null };
  }

  if (args.notifyMember) {
    const { data: member } = await admin
      .from("members")
      .select("name, email")
      .eq("id", args.memberId)
      .maybeSingle();
    if (member?.email) {
      const template = monthlyPassesCreditedEmail({
        name: member.name,
        quantity: plan.monthlyDayPasses,
        newBalance: typeof newBalance === "number" ? newBalance : null,
        planLabel: planLabel(args.planKey),
        siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz",
      });
      sendEmail({
        to: member.email,
        subject: template.subject,
        html: template.html,
        text: template.text,
      }).catch((error) => console.error("[SubscriptionPasses] credit email failed:", error));
    }
  }

  return {
    granted: true,
    newBalance: typeof newBalance === "number" ? newBalance : null,
  };
}
