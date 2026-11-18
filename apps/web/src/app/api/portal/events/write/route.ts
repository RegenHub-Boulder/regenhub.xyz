import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { techneConfig } from "@/lib/techne/config";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { techneSession } from "@/lib/techne/serverSession";
import { sameSiteJson } from "@/lib/techne/guard";
import { deleteEventBatch, putEventBatch, type EventInput, type ExistingEvent } from "@/lib/techne/collectiveEvents";
import { sendCollectiveBatch, writeErrorText } from "@/lib/techne/collectiveWrite";

/**
 * POST /api/portal/events/write { op: "create" | "update" | "delete", input, existing } — a steward's change to
 * RegenHub's calendar, sent by this server with the steward's own Techne session (one sign-in; the browser holds
 * no Techne session). The batch is built here with the collective as the repo (lib/techne/collectiveEvents.ts) and
 * sent straight to the steward's PDS (lib/techne/collectiveWrite.ts): Techne decides whether this account may post
 * as RegenHub. Needs the portal session and a Techne sign-in. 404 while the door is off.
 *   → { ok: true } | { ok: false, error }  (the steward reads `error`: Techne's own words after a plain line)
 */
export async function POST(req: Request) {
  const config = techneConfig();
  const collective = regenosCollectiveDid();
  if (!config || !collective) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refused = sameSiteJson(req);
  if (refused) return refused;
  const {
    data: { user },
  } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

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

  const signedIn = await techneSession(createServiceClient());
  if (!signedIn) {
    return NextResponse.json({ ok: false, error: "Your Techne sign-in has ended. Sign in with Techne again, then retry." }, { status: 401 });
  }
  let batch;
  try {
    batch = op === "delete" ? deleteEventBatch(collective, known!) : putEventBatch(collective, body!.input as EventInput, known);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "That event can't be posted." }, { status: 400 });
  }
  const out = await sendCollectiveBatch(signedIn.session, config, batch);
  if (out.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: false, error: writeErrorText(out) }, { status: out.kind === "refused" ? 403 : 502 });
}
