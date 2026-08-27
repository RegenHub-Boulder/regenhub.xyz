import { createServiceClient } from "@/lib/supabase/admin";
import {
  NATIVE_USDC_ADDRESS,
  ONCHAIN_CHAIN_ID,
  ONCHAIN_DISCOUNT_BPS,
  ONCHAIN_REMINDER_DAYS,
  TREASURY_ADDRESS,
} from "./config";

type ServiceClient = ReturnType<typeof createServiceClient>;

export function discountedCents(baseCents: number, discountBps = ONCHAIN_DISCOUNT_BPS): number {
  if (!Number.isInteger(baseCents) || baseCents <= 0) throw new Error("base cents must be positive");
  return Math.round((baseCents * (10_000 - discountBps)) / 10_000);
}

export function addCalendarMonth(iso: string): string {
  const source = new Date(iso);
  if (Number.isNaN(source.getTime())) throw new Error("invalid billing date");
  const year = source.getUTCFullYear();
  const month = source.getUTCMonth();
  const day = source.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  source.setUTCFullYear(year, month + 1, Math.min(day, lastDay));
  return source.toISOString();
}

export function invoiceValues(args: {
  subscriptionId: number;
  memberId: number;
  periodStart: string;
  baseAmountCents: number;
  dueAt?: string;
}) {
  const amountCents = discountedCents(args.baseAmountCents);
  return {
    subscription_id: args.subscriptionId,
    member_id: args.memberId,
    period_start: args.periodStart,
    period_end: addCalendarMonth(args.periodStart),
    due_at: args.dueAt ?? args.periodStart,
    base_amount_cents: args.baseAmountCents,
    discount_bps: ONCHAIN_DISCOUNT_BPS,
    amount_cents: amountCents,
    amount_usdc_micros: amountCents * 10_000,
    chain_id: ONCHAIN_CHAIN_ID,
    token_contract: NATIVE_USDC_ADDRESS,
    treasury_address: TREASURY_ADDRESS,
    status: "open" as const,
  };
}

/** Generate the next invoice for on-chain subscriptions inside the reminder window. */
export async function generateUpcomingOnchainInvoices(
  admin: ServiceClient,
  now = new Date(),
) {
  const reminderCutoff = new Date(
    now.getTime() + ONCHAIN_REMINDER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: subscriptions, error } = await admin
    .from("subscriptions")
    .select("id, member_id, monthly_cents, current_period_end")
    .eq("payment_rail", "onchain")
    .in("status", ["active", "trialing", "past_due"])
    .not("current_period_end", "is", null)
    .lte("current_period_end", reminderCutoff);
  if (error) throw error;

  const created = [];
  for (const subscription of subscriptions ?? []) {
    if (!subscription.current_period_end) continue;
    const values = invoiceValues({
      subscriptionId: subscription.id,
      memberId: subscription.member_id,
      periodStart: subscription.current_period_end,
      baseAmountCents: subscription.monthly_cents,
    });
    const { data, error: insertError } = await admin
      .from("onchain_invoices")
      .upsert(values, {
        onConflict: "subscription_id,period_start",
        ignoreDuplicates: true,
      })
      .select("*")
      .maybeSingle();
    if (insertError) throw insertError;
    if (data) created.push(data);
  }
  return created;
}

/** Start the shared grace clock when an on-chain invoice reaches its due date unpaid. */
export async function markDueOnchainSubscriptionsPastDue(
  admin: ServiceClient,
  now = new Date(),
) {
  const nowIso = now.toISOString();
  const { data: due, error } = await admin
    .from("onchain_invoices")
    .select("id, subscription_id")
    .in("status", ["open", "submitted", "detected"])
    .lte("due_at", nowIso);
  if (error) throw error;

  for (const invoice of due ?? []) {
    await admin
      .from("subscriptions")
      .update({ status: "past_due", past_due_since: nowIso })
      .eq("id", invoice.subscription_id)
      // An incomplete subscription represents a first payment that has never
      // been credited. It must not become scene membership or enter access
      // downgrade machinery merely because its setup window elapsed.
      .in("status", ["active", "trialing", "past_due"])
      .is("past_due_since", null);
  }
  return due?.length ?? 0;
}
