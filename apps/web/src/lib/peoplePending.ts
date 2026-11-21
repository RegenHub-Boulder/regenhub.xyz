import type { createClient } from "@/lib/supabase/server";
import type { createServiceClient } from "@/lib/supabase/admin";

/**
 * The People tabs' badges: applications and free-day requests waiting on a decision. Counts only (head reads).
 * A failed read leaves its badge off rather than showing a wrong number.
 */
export async function peoplePending(
  session: Awaited<ReturnType<typeof createClient>>,
  service: ReturnType<typeof createServiceClient>,
): Promise<{ applications?: number; freedays?: number }> {
  const [apps, claims] = await Promise.all([
    session.from("applications").select("id", { count: "exact", head: true }).eq("status", "pending"),
    service.from("free_day_claims").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);
  return {
    applications: apps.error ? undefined : apps.count ?? 0,
    freedays: claims.error ? undefined : claims.count ?? 0,
  };
}
