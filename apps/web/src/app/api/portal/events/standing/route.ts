import { NextResponse, type NextRequest } from "next/server";
import { isTechneSignInEnabled } from "@/lib/techne/config";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { fetchStanding } from "@/lib/techne/standing";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/portal/events/standing?did=<did>
 *
 * The signed-in Techne person's role in the RegenHub collective, from the collective's public
 * membership claims (lib/techne/standing.ts). The browser knows its DID from its Techne session;
 * the answer is public data. It is only a hint on /portal/events (Techne checks every write itself),
 * so it asks for the portal session the page already has and reads Techne through a one-minute cache:
 * nobody outside the portal can make the server query Techne at will.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const collective = regenosCollectiveDid();
  if (!isTechneSignInEnabled() || !collective) return NextResponse.json({ error: "NotFound" }, { status: 404 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const did = req.nextUrl.searchParams.get("did") ?? "";
  if (!/^did:(plc|web):[A-Za-z0-9._:%-]{1,256}$/.test(did)) {
    return NextResponse.json({ error: "InvalidRequest", message: "did must be a did:plc or did:web" }, { status: 400 });
  }
  const standing = await fetchStanding(collective, did);
  if (!standing) return NextResponse.json({ error: "Unavailable", message: "Couldn't read Techne" }, { status: 502 });
  return NextResponse.json({ did, collective, ...standing }, { headers: { "cache-control": "no-store" } });
}
