import type { SupabaseClient } from "@supabase/supabase-js";
import { isGaslessRelayConfigured } from "./config";

/**
 * Migration 063 adds `onchain_invoices.kind` (and `wallet_id`, and
 * `purchases.onchain_invoice_id`). `run_migration` can only apply it once
 * the code that ships it is deployed, so this code runs on the old schema for
 * a while. Before 063 every on-chain invoice is a membership invoice, so a
 * reader that narrows to memberships can simply drop the filter.
 *
 * Subtract: once 063 is applied in production, `membershipInvoices` can go
 * back to a plain `.eq("kind", "membership")` and `isMissingFunction` can go;
 * the `onchainPassesReady` probe can go with them (`onchainPassesOpen` keeps the relayer check).
 */

/** Postgres undefined_column, as PostgREST passes it on (or reports it from its schema cache). */
export function isMissingColumn(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}

/** Postgres undefined_function / PostgREST "no such function": an RPC that a later migration adds. */
export function isMissingFunction(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42883" || error?.code === "PGRST202";
}

/**
 * Run a query over membership invoices. `query(true)` adds the
 * `kind = 'membership'` filter; if the column doesn't exist yet (pre-063) it
 * runs once more as `query(false)`, unfiltered, which is the same set.
 */
export async function membershipInvoices<R extends { error: { code?: string } | null }>(
  query: (kindColumn: boolean) => PromiseLike<R>,
): Promise<R> {
  const result = await query(true);
  return isMissingColumn(result.error) ? query(false) : result;
}

/** Whether a day pass can be bought in USDC: the gasless relayer is set up and migration 063 is applied. */
export async function onchainPassesOpen(client: SupabaseClient): Promise<boolean> {
  return isGaslessRelayConfigured() && onchainPassesReady(client);
}

/** Whether migration 063 is applied (USDC day passes can be bought). A failed probe for any other reason says yes. */
export async function onchainPassesReady(client: SupabaseClient): Promise<boolean> {
  // A filter on the column, which fails without it wherever the query runs.
  const { error } = await client.from("onchain_invoices").select("id").eq("kind", "day_pass").limit(1);
  return !isMissingColumn(error);
}
