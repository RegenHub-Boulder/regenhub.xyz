/**
 * The person's Techne session for a server route: this browser's sign-in (webSession) and the OAuth session the
 * server holds for that DID. When the OAuth session can't be used any more (revoked, refresh refused), the
 * browser's sign-in ends too, so the page shows "Sign in with Techne" again instead of failing every call.
 */

import type { createServiceClient } from "@/lib/supabase/admin";
import type { Session } from "./call";
import { techneOAuth } from "./oauth/client";
import { currentTechne, endWebSession, type TechneVisitor } from "./webSession";

type Admin = ReturnType<typeof createServiceClient>;

export async function techneSession(admin: Admin): Promise<{ who: TechneVisitor; session: Session } | null> {
  const oauth = techneOAuth();
  if (!oauth) return null;
  const who = await currentTechne(admin);
  if (!who) return null;
  const session = await (await oauth).restore(who.did);
  if (!session) {
    await endWebSession(admin).catch(() => null);
    return null;
  }
  return { who, session };
}
