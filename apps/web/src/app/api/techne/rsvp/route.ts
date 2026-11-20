import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { techneConfig } from "@/lib/techne/config";
import { TechneUnreachable, endLapsedSession, techneSession, unreachableResponse as unreachable } from "@/lib/techne/serverSession";
import { ownRsvp, writeRsvp } from "@/lib/techne/rsvpWrite";
import { isLapsedToken, isSignedOutAnswer } from "@/lib/techne/call";
import { sameSiteJson } from "@/lib/techne/guard";
import { MEMBERS_ONLY_REFUSAL, rsvpGate } from "@/lib/techne/rsvpGate";
import type { RsvpStatus } from "@/lib/techne/rsvp";

/**
 * RSVP through this server's Techne session (the browser holds none: one door, one sign-in).
 *   GET  ?event=<at-uri>                 → { signedIn: false } | { signedIn: true, did, handle, own, gate }
 *   POST { event: {uri, cid}, status, rkey? } → { rkey, status }: the person's own RSVP record, written on their PDS
 *        (`rkey`: the record GET answered, so a change rewrites it; without it the server looks it up first)
 * A members-only night (Studio Night) takes a member in standing: GET says `gate: "not-member"`, POST answers 403
 * (lib/techne/rsvpGate.ts). An event this site can't read back is refused (404/503), never guessed.
 * 404 while the door is off.
 */
export const dynamic = "force-dynamic";

const AT_URI = /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/[A-Za-z0-9.]+\/[A-Za-z0-9._:~-]+$/;

export async function GET(req: NextRequest) {
  if (!techneConfig()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const event = req.nextUrl.searchParams.get("event") ?? "";
  if (!AT_URI.test(event)) return NextResponse.json({ error: "Which event?" }, { status: 400 });
  let signedIn;
  try {
    signedIn = await techneSession(createServiceClient());
  } catch (err) {
    if (err instanceof TechneUnreachable) return unreachable();
    throw err;
  }
  if (!signedIn) return NextResponse.json({ signedIn: false }, { headers: { "cache-control": "no-store" } });
  let own;
  try {
    own = await ownRsvp(signedIn.session, event);
  } catch (err) {
    // The PDS no longer takes this session's token: signed out, so the panel offers sign-in again.
    if (isSignedOutAnswer(err)) {
      await endLapsedSession(createServiceClient(), signedIn.who.did);
      return NextResponse.json({ signedIn: false }, { headers: { "cache-control": "no-store" } });
    }
    return unreachable(); // a look-up that failed must not read as "not answered yet"
  }
  let gate;
  try {
    gate = await rsvpGate(createServiceClient(), event, signedIn.who.did);
  } catch {
    return unreachable();
  }
  return NextResponse.json(
    { signedIn: true, did: signedIn.who.did, handle: signedIn.who.handle, own, gate },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const config = techneConfig();
  if (!config) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refused = sameSiteJson(req);
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as {
    event?: { uri?: unknown; cid?: unknown };
    status?: unknown;
    rkey?: unknown;
  } | null;
  const uri = body?.event?.uri;
  const cid = body?.event?.cid;
  const status = body?.status;
  if (typeof uri !== "string" || !AT_URI.test(uri) || typeof cid !== "string" || !/^[a-z0-9]{8,100}$/i.test(cid)) {
    return NextResponse.json({ error: "Which event?" }, { status: 400 });
  }
  if (status !== "going" && status !== "notgoing" && status !== "interested") {
    return NextResponse.json({ error: "Going or not?" }, { status: 400 });
  }
  const known = typeof body?.rkey === "string" && /^[a-z2-7]{13}$/.test(body.rkey) ? body.rkey : null;
  let signedIn;
  try {
    signedIn = await techneSession(createServiceClient());
  } catch (err) {
    if (err instanceof TechneUnreachable) return unreachable();
    throw err;
  }
  if (!signedIn) return NextResponse.json({ error: "Sign in with Techne again." }, { status: 401 });
  let gate;
  try {
    gate = await rsvpGate(createServiceClient(), uri, signedIn.who.did);
  } catch {
    return unreachable();
  }
  // A non-member may still say they can't make it (a lapsed member's earlier "going" shouldn't stay counted).
  if (gate === "not-member" && status !== "notgoing") {
    return NextResponse.json({ error: MEMBERS_ONLY_REFUSAL }, { status: 403 });
  }
  if (gate === "unknown") {
    return NextResponse.json({ error: "Couldn't find that event just now. Reload and try again." }, { status: 404 });
  }
  try {
    // Never guess: a failed look-up must not write a second RSVP for the same event.
    const rkey0 = known ?? (await ownRsvp(signedIn.session, uri))?.rkey;
    const rkey = await writeRsvp(signedIn.session, config, { uri, cid }, status as RsvpStatus, rkey0);
    return NextResponse.json({ rkey, status });
  } catch (err) {
    if (isLapsedToken(err)) {
      await endLapsedSession(createServiceClient(), signedIn.who.did);
      return NextResponse.json({ error: "Your Techne sign-in has ended. Sign in with Techne again." }, { status: 401 });
    }
    console.warn("[techne] RSVP write failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't save your RSVP. Try again." }, { status: 502 });
  }
}
