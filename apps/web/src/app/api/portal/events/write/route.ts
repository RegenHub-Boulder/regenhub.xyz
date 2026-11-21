import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { createServiceClient } from "@/lib/supabase/admin";
import { techneConfig } from "@/lib/techne/config";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { TechneUnreachable, endLapsedSession, techneSession, unreachableResponse } from "@/lib/techne/serverSession";
import { sameSiteJson, tooMany, withinIpLimit } from "@/lib/techne/guard";
import { stewardCheck } from "@/lib/techne/roster";
import { TECHNE_READS_TAG } from "@/lib/techne/query";
import { deleteEventBatch, putEventBatch, type EventInput, type ExistingEvent } from "@/lib/techne/collectiveEvents";
import { sendCollectiveBatch, writeErrorText } from "@/lib/techne/collectiveWrite";

/**
 * POST /api/portal/events/write { op: "create" | "update" | "delete", input, existing } — a steward's change to
 * RegenHub's calendar, sent by this server with the steward's own Techne session (one sign-in; the browser holds
 * no Techne session). The batch is built here with the collective as the repo (lib/techne/collectiveEvents.ts) and
 * sent straight to the steward's PDS (lib/techne/collectiveWrite.ts): Techne decides whether this account may post
 * as RegenHub.
 *
 * Authority is the Techne role, as for Events → Roles: the caller must be signed in with Techne and hold
 * facilitator or above in RegenHub's public membership claims, read fresh here (lib/techne/roster.ts
 * stewardCheck). No portal session is read: a site membership neither grants this nor is needed. Techne checks
 * again on the write. A change that lands expires the cached Techne reads and `/`, so every page shows it.
 * 404 while the door is off.
 *   → { ok: true } | { ok: false, error }  (the steward reads `error`: Techne's own words after a plain line)
 */
export async function POST(req: Request) {
  const config = techneConfig();
  const collective = regenosCollectiveDid();
  if (!config || !collective) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refused = sameSiteJson(req);
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as {
    op?: unknown;
    input?: unknown;
    existing?: { rkey?: unknown; value?: unknown; config?: unknown; hasListing?: unknown } | null;
  } | null;
  const op = body?.op;
  if (op !== "create" && op !== "update" && op !== "delete") return NextResponse.json({ error: "What change?" }, { status: 400 });
  const e = body?.existing;
  const known: ExistingEvent | null =
    e && typeof e.rkey === "string" && /^[A-Za-z0-9._~-]{1,64}$/.test(e.rkey) && e.value && typeof e.value === "object"
      ? {
          rkey: e.rkey,
          value: e.value as Record<string, unknown>,
          config: e.config && typeof e.config === "object" ? (e.config as Record<string, unknown>) : null,
          hasListing: e.hasListing === true,
        }
      : null;
  if (op !== "create" && !known) {
    return NextResponse.json({ ok: false, error: "That event isn't on the page any more. Reload and try again." }, { status: 400 });
  }
  if (op !== "delete" && (!body?.input || typeof body.input !== "object")) {
    return NextResponse.json({ error: "What event?" }, { status: 400 });
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
  // Counted once signed in, so signed-out calls can't spend the hub's shared IP budget.
  if (!(await withinIpLimit(admin, req, "events"))) return tooMany();
  const check = await stewardCheck(collective, signedIn.who.did);
  if (!check) {
    return NextResponse.json({ ok: false, error: "Couldn't read RegenHub's roles from Techne just now. Try again in a moment." }, { status: 503 });
  }
  if (!check.steward) {
    return NextResponse.json(
      { ok: false, error: "Only RegenHub's facilitators and managers on Techne can post its events." },
      { status: 403 },
    );
  }
  let batch;
  try {
    batch = op === "delete" ? deleteEventBatch(collective, known!) : putEventBatch(collective, body!.input as EventInput, known);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "That event can't be posted." }, { status: 400 });
  }
  const out = await sendCollectiveBatch(signedIn.session, config, batch);
  if (out.ok) {
    revalidateTag(TECHNE_READS_TAG, { expire: 0 });
    revalidatePath("/");
    return NextResponse.json({ ok: true });
  }
  // A token the PDS no longer takes: end this sign-in here too, as RSVP does, so the page offers sign-in again.
  if (out.kind === "signin") await endLapsedSession(admin, signedIn.who.did);
  return NextResponse.json({ ok: false, error: writeErrorText(out) }, { status: out.kind === "refused" ? 403 : 502 });
}
