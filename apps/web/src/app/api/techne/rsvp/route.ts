import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { techneConfig } from "@/lib/techne/config";
import { techneSession } from "@/lib/techne/serverSession";
import { ownRsvp, writeRsvp } from "@/lib/techne/rsvpWrite";
import { sameSiteJson } from "@/lib/techne/guard";
import type { RsvpStatus } from "@/lib/techne/rsvp";

/**
 * RSVP through this server's Techne session (the browser holds none: one door, one sign-in).
 *   GET  ?event=<at-uri>                 → { signedIn: false } | { signedIn: true, did, handle, own }
 *   POST { event: {uri, cid}, status }   → { rkey, status }: the person's own RSVP record, written on their PDS
 * 404 while the door is off.
 */
export const dynamic = "force-dynamic";

const AT_URI = /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/[A-Za-z0-9.]+\/[A-Za-z0-9._:~-]+$/;

export async function GET(req: NextRequest) {
  if (!techneConfig()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const event = req.nextUrl.searchParams.get("event") ?? "";
  if (!AT_URI.test(event)) return NextResponse.json({ error: "Which event?" }, { status: 400 });
  const signedIn = await techneSession(createServiceClient());
  if (!signedIn) return NextResponse.json({ signedIn: false }, { headers: { "cache-control": "no-store" } });
  const own = await ownRsvp(signedIn.session, event).catch(() => null);
  return NextResponse.json(
    { signedIn: true, did: signedIn.who.did, handle: signedIn.who.handle, own },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const config = techneConfig();
  if (!config) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refused = sameSiteJson(req);
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as { event?: { uri?: unknown; cid?: unknown }; status?: unknown } | null;
  const uri = body?.event?.uri;
  const cid = body?.event?.cid;
  const status = body?.status;
  if (typeof uri !== "string" || !AT_URI.test(uri) || typeof cid !== "string" || !/^[a-z0-9]{8,100}$/i.test(cid)) {
    return NextResponse.json({ error: "Which event?" }, { status: 400 });
  }
  if (status !== "going" && status !== "notgoing" && status !== "interested") {
    return NextResponse.json({ error: "Going or not?" }, { status: 400 });
  }
  const signedIn = await techneSession(createServiceClient());
  if (!signedIn) return NextResponse.json({ error: "Sign in with Techne again." }, { status: 401 });
  try {
    const own = await ownRsvp(signedIn.session, uri).catch(() => null);
    const rkey = await writeRsvp(signedIn.session, config, { uri, cid }, status as RsvpStatus, own?.rkey);
    return NextResponse.json({ rkey, status });
  } catch (err) {
    console.warn("[techne] RSVP write failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't save your RSVP. Try again." }, { status: 502 });
  }
}
