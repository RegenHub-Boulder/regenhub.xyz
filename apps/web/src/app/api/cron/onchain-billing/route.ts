import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { generateUpcomingOnchainInvoices, isRenewalInvoice, markDueOnchainSubscriptionsPastDue } from "@/lib/onchain/invoice";
import { advanceFinalizedOnchainPayments, processOnchainInvoice, retryPendingOnchainEffects } from "@/lib/onchain/verifyPayment";
import { isGaslessRelayConfigured } from "@/lib/onchain/config";
import { processGaslessRelayQueue } from "@/lib/onchain/gaslessRelay";
import { onchainRenewalReminderEmail, sendEmail } from "@/lib/email";
import { planLabel } from "@/lib/plans";

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = createServiceClient();
  const gaslessRelays = [];
  if (isGaslessRelayConfigured()) {
    for (let index = 0; index < 10; index += 1) {
      try {
        const relay = await processGaslessRelayQueue(admin);
        if (relay.status === "empty" || relay.status === "busy") break;
        gaslessRelays.push(relay);
      } catch (cause) {
        gaslessRelays.push({
          status: "retry_error",
          error: cause instanceof Error ? cause.message : "unknown",
        });
        break;
      }
    }
  }
  const created = await generateUpcomingOnchainInvoices(admin);
  const { data: unsentReminders, error: reminderQueryError } = await admin
    .from("onchain_invoices")
    .select("*")
    .in("status", ["open", "submitted", "detected"])
    .is("reminder_sent_at", null)
    .order("due_at", { ascending: true })
    .limit(100);
  if (reminderQueryError) throw reminderQueryError;
  let remindersSent = 0;
  for (const invoice of unsentReminders ?? []) {
    // A first-payment invoice uses due_at as its seven-day setup deadline;
    // it is not a renewal date and must not receive a renewal reminder.
    if (!isRenewalInvoice(invoice)) continue;
    const { data: member } = await admin.from("members").select("name, email").eq("id", invoice.member_id).single();
    const { data: subscription } = await admin.from("subscriptions").select("plan_key").eq("id", invoice.subscription_id).single();
    if (!member?.email || !subscription) continue;
    const mail = onchainRenewalReminderEmail({
      name: member.name,
      planLabel: planLabel(subscription.plan_key),
      amountUsdc: (invoice.amount_cents / 100).toFixed(2),
      renewalDate: new Date(invoice.period_start).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz",
    });
    if (await sendEmail({ to: member.email, ...mail })) {
      await admin.from("onchain_invoices").update({ reminder_sent_at: new Date().toISOString() }).eq("id", invoice.id);
      remindersSent += 1;
    }
  }

  const pastDue = await markDueOnchainSubscriptionsPastDue(admin);
  const { data: pending, error } = await admin.from("onchain_invoices")
    .select("id").in("status", ["submitted", "detected"]).order("submitted_at", { ascending: true }).limit(50);
  if (error) throw error;
  const confirmations = [];
  for (const invoice of pending ?? []) {
    try { confirmations.push(await processOnchainInvoice(admin, invoice.id)); }
    catch (cause) { confirmations.push({ status: "retry_error", invoiceId: invoice.id, error: cause instanceof Error ? cause.message : "unknown" }); }
  }
  await retryPendingOnchainEffects(admin);
  const finalized = await advanceFinalizedOnchainPayments(admin);
  return NextResponse.json({ gaslessRelays, invoicesCreated: created.length, remindersSent, pastDue, confirmations, finalized });
}
