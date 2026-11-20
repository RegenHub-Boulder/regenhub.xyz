import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { techneConfig } from "@/lib/techne/config";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { currentTechne } from "@/lib/techne/webSession";
import { sameSiteJson, tooMany, withinIpLimit } from "@/lib/techne/guard";
import { stewardCheck } from "@/lib/techne/roster";
import { decideNightFollowups } from "@/lib/nightFollowupData";

/**
 * POST /api/portal/events/followups { event: <at-uri>, decision: "send" | "skip", keep: [memberId, …] } — a steward's
 * click on a night's follow-ups on /admin/events. The only way a follow-up is sent: nothing else calls
 * decideNightFollowups. Gated like the events write route: signed in with Techne here and facilitator or above in
 * RegenHub's roster, read fresh (lib/techne/roster.ts stewardCheck). A night is decided once.
 *   → { ok: true, sent, failed, held } | { ok: false, error }
 */
export async function POST(req: Request) {
  const collective = regenosCollectiveDid();
  if (!techneConfig() || !collective) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refused = sameSiteJson(req);
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as { event?: unknown; decision?: unknown; keep?: unknown } | null;
  const event = body?.event;
  const decision = body?.decision;
  if (typeof event !== "string" || !/^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/community\.lexicon\.calendar\.event\/[A-Za-z0-9._:~-]+$/.test(event)) {
    return NextResponse.json({ ok: false, error: "Which night?" }, { status: 400 });
  }
  if (decision !== "send" && decision !== "skip") return NextResponse.json({ ok: false, error: "Send or skip?" }, { status: 400 });
  const keep = Array.isArray(body?.keep) ? body.keep.filter((n): n is number => Number.isInteger(n) && (n as number) > 0) : [];

  const admin = createServiceClient();
  const who = await currentTechne(admin);
  if (!who) return NextResponse.json({ ok: false, error: "Sign in with Techne again, then retry." }, { status: 401 });
  if (!(await withinIpLimit(admin, req, "events"))) return tooMany();
  const check = await stewardCheck(collective, who.did);
  if (!check) {
    return NextResponse.json({ ok: false, error: "Couldn't read RegenHub's roles from Techne just now. Try again in a moment." }, { status: 503 });
  }
  if (!check.steward) {
    return NextResponse.json({ ok: false, error: "Only RegenHub's facilitators and managers on Techne can send follow-ups." }, { status: 403 });
  }
  const out = await decideNightFollowups(admin, { eventUri: event, decision, keep, stewardDid: who.did });
  if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: out.status });
  return NextResponse.json(out);
}
