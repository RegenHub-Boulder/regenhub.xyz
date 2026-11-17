import { NextResponse, type NextRequest } from "next/server";
import { isTechneSignInEnabled } from "@/lib/techne/config";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { fetchStanding } from "@/lib/techne/standing";

/**
 * GET /api/portal/events/standing?did=<did>
 *
 * The signed-in Techne person's role in the RegenHub collective, from the collective's public
 * membership claims (lib/techne/standing.ts). The browser knows its DID from its Techne session;
 * the answer is public data, so the route needs no session of its own. It only decides what
 * /portal/events shows; Techne checks every write itself.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const collective = regenosCollectiveDid();
  if (!isTechneSignInEnabled() || !collective) return NextResponse.json({ error: "NotFound" }, { status: 404 });
  const did = req.nextUrl.searchParams.get("did") ?? "";
  if (!/^did:(plc|web):[A-Za-z0-9._:%-]{1,256}$/.test(did)) {
    return NextResponse.json({ error: "InvalidRequest", message: "did must be a did:plc or did:web" }, { status: 400 });
  }
  const standing = await fetchStanding(collective, did);
  if (!standing) return NextResponse.json({ error: "Unavailable", message: "Couldn't read Techne" }, { status: 502 });
  return NextResponse.json({ did, collective, ...standing }, { headers: { "cache-control": "no-store" } });
}
