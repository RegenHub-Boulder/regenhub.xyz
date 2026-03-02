import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. ONLY use from server-side admin API routes.
 * Bypasses RLS — never expose to the browser or import from client components.
 */
export function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}
