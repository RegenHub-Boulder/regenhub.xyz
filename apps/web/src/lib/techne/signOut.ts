/**
 * Sign-out ends both sessions this site holds (the one door): the Techne session in the browser (revoked at
 * the person's PDS and forgotten here, techne-sdk `signOut`) and the portal (Supabase) session, whose cookies
 * only the server can clear (POST /auth/signout). Every "Sign out" on the site calls this.
 */

import type { TechneConfig } from "./config";
import { authOptions } from "./session";

export async function signOutOfTechne(config: TechneConfig | null, session?: { did: string } | null): Promise<void> {
  if (!config) return;
  try {
    const auth = await import("techne-sdk/auth");
    const opts = await authOptions(config);
    const s = session ?? (await auth.restore(opts).catch(() => null));
    if (s) await auth.signOut({ ...opts, session: s as never });
  } catch {
    // A PDS that can't be reached must not keep anyone signed in here: signOut forgets locally first.
  }
}

export async function signOutEverywhere(
  config: TechneConfig | null,
  session?: { did: string } | null,
  f: typeof fetch = fetch,
): Promise<void> {
  await signOutOfTechne(config, session);
  await f("/auth/signout", { method: "POST", redirect: "manual", credentials: "same-origin" }).catch(() => {});
}
