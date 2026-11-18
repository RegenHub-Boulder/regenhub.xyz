import { createClient } from "@/lib/supabase/server";
import type { createServiceClient } from "@/lib/supabase/admin";

/**
 * Start a Supabase session for `email` on this response, server-side, with no email sent. Used by the
 * one door (POST /api/auth/techne/session, /link/confirm) and the old regenOS lane.
 *
 * The repo's precedent for server-side provisioning is `signInWithOtp({ shouldCreateUser: true })`, but it
 * EMAILS a link. So: `generateLink` (admin API, sends nothing, returns the hashed token) redeemed at once by
 * `verifyOtp`, which writes the `sb-regenhub` cookies through the server client's cookie adapter.
 *
 * When no auth.users row exists yet, current GoTrue auto-creates an unconfirmed user and mints a
 * `signup`-type token (older GoTrue errors instead: then createUser with `email_confirm`). The redeem must
 * use the `verification_type` GoTrue says it minted: a signup token redeemed as "magiclink" fails. Trigger
 * 004 links a new auth user to the member row by email.
 *
 * Callers decide WHO may get a session; this only does the minting.
 */
export async function mintSupabaseSession(
  admin: ReturnType<typeof createServiceClient>,
  email: string,
  tag = "auth",
): Promise<{ ok: true } | { ok: false; error: string }> {
  let link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) {
    const { error: createError } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createError) {
      console.error(`[${tag}] auth user provisioning failed:`, createError);
      return { ok: false, error: "Couldn't create your sign-in." };
    }
    link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  }
  const tokenHash = link.data?.properties?.hashed_token;
  const verificationType = link.data?.properties?.verification_type;
  if (link.error || !tokenHash || !verificationType) {
    console.error(`[${tag}] generateLink failed:`, link.error);
    return { ok: false, error: "Couldn't create your sign-in." };
  }
  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: verificationType as "magiclink" | "signup",
    token_hash: tokenHash,
  });
  if (verifyError) {
    console.error(`[${tag}] verifyOtp failed:`, verifyError);
    return { ok: false, error: "Couldn't start your session." };
  }
  return { ok: true };
}
