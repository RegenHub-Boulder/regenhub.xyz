import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { doorOff, notFound, requireTechne } from "@/lib/techne/portalDoor";
import { sameSiteJson, tooMany, withinIpLimit } from "@/lib/techne/guard";

/**
 * POST /api/techne/newsletter { choice: "no" } — "No thanks" on the line shown after a Techne sign-in put the person on
 * the stay-in-touch list (T-497). Takes back only the list row that sign-in added and remembers the answer, so no
 * later sign-in adds them again (migration 067 decline_techne_newsletter). Who: this browser's Techne sign-in.
 * It is not an unsubscribe: notes after a night they RSVP'd to have their own "no more notes" link.
 */
export async function POST(request: Request) {
  if (doorOff()) return notFound();
  const refused = sameSiteJson(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { choice?: unknown } | null;
  if (body?.choice !== "no") return NextResponse.json({ error: "Say { choice: \"no\" }." }, { status: 400 });
  const admin = createServiceClient();
  const signedIn = await requireTechne(admin);
  if (!signedIn.ok) return signedIn.response;
  if (!(await withinIpLimit(admin, request, "newsletter"))) return tooMany();
  const { error } = await admin.rpc("decline_techne_newsletter", { p_did: signedIn.who.did });
  if (error) {
    console.error("[techne] newsletter decline failed:", error.message);
    return NextResponse.json({ error: "Couldn't save that just now. Try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
