import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sameSiteJson } from "@/lib/techne/guard";
import { sessionIdOf, unlinkTechne } from "@/lib/techne/unlink";
import { currentTechne, endWebSession } from "@/lib/techne/webSession";

/**
 * POST /api/portal/techne/unlink — the signed-in member unlinks their Techne account (/portal/profile). Their other
 * portal sessions end (a session someone opened with a link they made stops being renewed); this one stays. Works
 * with the door on or off, so a link can always be undone.
 */
export async function POST(req: Request) {
  const refused = sameSiteJson(req);
  if (refused) return refused;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const admin = createServiceClient();
  const { data: member } = await admin.from("members").select("id, did").eq("supabase_user_id", user.id).maybeSingle();
  if (!member) return NextResponse.json({ error: "No membership on this account." }, { status: 404 });
  if (!member.did) return NextResponse.json({ unlinked: null });

  const { data: sessionData } = await supabase.auth.getSession();
  const out = await unlinkTechne(admin, member.id as number, member.id as number, sessionIdOf(sessionData.session?.access_token));
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 500 });
  // This browser's Techne sign-in as that account is gone server-side; drop its cookie too.
  if ((await currentTechne(admin).catch(() => null)) === null) await endWebSession(admin).catch(() => null);
  return NextResponse.json({ unlinked: out.did });
}
