import { NextResponse } from "next/server";
import { requireAdminMember } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { AuditAction, logAction } from "@/lib/auditLog";
import { ACTION_ID } from "@/lib/scoreboardActions";

/**
 * POST /api/admin/scoreboard/actions { id, fingerprint, state: "done" | "not_now" | "open" }
 *
 * Marks a recommended action on /admin/scoreboard. One admin_actions row per mark; the latest per action wins. The
 * fingerprint is the facts the admin saw: when the facts change the action comes back on its own.
 */
export async function POST(req: Request) {
  const caller = await requireAdminMember();
  if (!caller) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { id?: unknown; fingerprint?: unknown; state?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const fingerprint = typeof body?.fingerprint === "string" ? body.fingerprint : null;
  const state = body?.state;
  if (!ACTION_ID.test(id) || fingerprint == null || fingerprint.length > 300 || (state !== "done" && state !== "not_now" && state !== "open")) {
    return NextResponse.json({ error: "Expected { id, fingerprint, state: done | not_now | open }" }, { status: 400 });
  }

  const result = await logAction({
    action: AuditAction.SCOREBOARD_ACTION_MARKED,
    actorMemberId: caller.member.id,
    target: { table: "scoreboard_actions", id },
    payload: { state, fingerprint },
  }, createServiceClient());
  if (!result.ok) return NextResponse.json({ error: "Couldn't save that; try again." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
