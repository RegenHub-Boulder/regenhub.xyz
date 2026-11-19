import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createServiceClient } from "@/lib/supabase/admin";
import { techneConfig } from "@/lib/techne/config";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { TechneUnreachable, endLapsedSession, techneSession, unreachableResponse } from "@/lib/techne/serverSession";
import { sameSiteJson } from "@/lib/techne/guard";
import { sendCollectiveBatch, writeErrorText } from "@/lib/techne/collectiveWrite";
import { MANAGE_ROLE, RosterRefusal, fetchRoster, holdersFrom, isOfferedRole, rosterBatch, type OfferedRole, type RosterChange } from "@/lib/techne/roster";
import { didForHandle } from "@/lib/techne/did";
import { TECHNE_READS_TAG } from "@/lib/techne/query";

/**
 * POST /api/techne/stewards — add, change or end a role in RegenHub on Techne (/admin/stewards).
 *   { op: "add", handle, role } | { op: "change", did, role } | { op: "end", did }
 *   → { ok: true } | { ok: false, error }
 *
 * Authority is the Techne role, not the portal: the caller must be signed in with Techne and hold facilitator or
 * above in RegenHub's public membership claims, read fresh here. The Supabase admin flag neither grants this nor is
 * needed (no portal session is read at all). Techne checks the same on the write (writeAsCollective). The roster is
 * read again here, never taken from the page, so the last-manager rule sees what Techne holds now.
 */
export async function POST(req: Request) {
  const config = techneConfig();
  const collective = regenosCollectiveDid();
  if (!config || !collective) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refused = sameSiteJson(req);
  if (refused) return refused;

  const body = (await req.json().catch(() => null)) as { op?: unknown; handle?: unknown; did?: unknown; role?: unknown } | null;
  const op = body?.op;
  if (op !== "add" && op !== "change" && op !== "end") return NextResponse.json({ ok: false, error: "What change?" }, { status: 400 });
  if (op !== "end" && !isOfferedRole(body?.role)) {
    return NextResponse.json({ ok: false, error: "Pick member, facilitator or manager." }, { status: 400 });
  }
  if (op === "add" ? typeof body?.handle !== "string" || !body.handle.trim() : typeof body?.did !== "string") {
    return NextResponse.json({ ok: false, error: op === "add" ? "Type their Techne handle." : "Who?" }, { status: 400 });
  }

  const admin = createServiceClient();
  let signedIn;
  try {
    signedIn = await techneSession(admin);
  } catch (err) {
    if (!(err instanceof TechneUnreachable)) throw err;
    return unreachableResponse();
  }
  if (!signedIn) {
    return NextResponse.json({ ok: false, error: "Your Techne sign-in has ended. Sign in with Techne again, then retry." }, { status: 401 });
  }

  const claims = await fetchRoster(collective);
  if (!claims) return NextResponse.json({ ok: false, error: "Couldn't read RegenHub's roles from Techne just now. Try again in a moment." }, { status: 503 });
  const me = holdersFrom(claims).find((h) => h.did === signedIn.who.did);
  if (!me || me.role < MANAGE_ROLE) {
    return NextResponse.json(
      { ok: false, error: "Only RegenHub's facilitators and managers on Techne can change its roles." },
      { status: 403 },
    );
  }

  let target: string;
  if (op === "add") {
    const found = await didForHandle(body!.handle as string);
    if (!found) {
      return NextResponse.json(
        { ok: false, error: `Couldn't find a Techne account for “${String(body!.handle).trim()}”. Check the handle (like name.techne.town).` },
        { status: 400 },
      );
    }
    target = found.did;
  } else target = body!.did as string;

  const change: RosterChange = op === "end" ? { op: "end", did: target } : { op: "set", did: target, role: body!.role as OfferedRole };
  let batch;
  try {
    batch = rosterBatch(collective, claims, change);
  } catch (err) {
    if (err instanceof RosterRefusal) return NextResponse.json({ ok: false, error: err.message }, { status: 409 });
    throw err;
  }
  const out = await sendCollectiveBatch(signedIn.session, config, batch);
  if (out.ok) {
    // The events page's role hint and every other cached Techne read.
    revalidateTag(TECHNE_READS_TAG, { expire: 0 });
    return NextResponse.json({ ok: true });
  }
  if (out.kind === "signin") await endLapsedSession(admin, signedIn.who.did);
  return NextResponse.json({ ok: false, error: writeErrorText(out, "roles") }, { status: out.kind === "refused" ? 403 : 502 });
}
